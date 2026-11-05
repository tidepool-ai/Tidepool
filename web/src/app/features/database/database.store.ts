import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { Database, Member, Property, PropertyType, PropertyValue, QueryResult, Row, schemaBody } from './database.api';

/** Rows fetched per request (the API's maximum). */
export const PAGE_SIZE = 100;

interface DatabaseState {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  database: Database | null;
  rows: Row[];
  cursor: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  members: Member[];
  /** The last thing that went wrong, for an alert. */
  error: string | null;
  /** The last change, for the polite live region. */
  announcement: string;
}

const initial: DatabaseState = {
  status: 'idle',
  database: null,
  rows: [],
  cursor: null,
  hasMore: false,
  loadingMore: false,
  members: [],
  error: null,
  announcement: '',
};

function reason(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse && typeof error.error?.detail === 'string') return error.error.detail;
  return fallback;
}

/** One database's schema and rows, for its table (T17). Provided per database view. */
export const DatabaseStore = signalStore(
  withState(initial),
  withComputed((store) => ({
    properties: computed(() => store.database()?.properties ?? []),
    view: computed(() => store.database()?.views[0] ?? null),
    /** Columns in order: the title first, then the view's visible properties (or all). */
    columns: computed((): Property[] => {
      const database = store.database();
      if (!database) return [];
      const visible = database.views[0]?.config.visible_properties;
      const byId = new Map(database.properties.map((p) => [p.id, p]));
      const title = database.properties.filter((p) => p.type === 'title');
      const rest = visible
        ? visible.map((id) => byId.get(id)).filter((p): p is Property => !!p && p.type !== 'title')
        : database.properties.filter((p) => p.type !== 'title');
      return [...title, ...rest];
    }),
    memberEmails: computed(() => new Map(store.members().map((m) => [m.user_id, m.email]))),
  })),
  withMethods((store, http = inject(HttpClient)) => {
    const query = (cursor: string | null) => {
      const database = store.database()!;
      return firstValueFrom(
        http.post<QueryResult>(`/api/databases/${database.id}/query`, {
          view_id: store.view()?.id,
          page_size: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
      );
    };
    const fail = (error: unknown, fallback: string) => patchState(store, { error: reason(error, fallback) });
    const replaceRow = (row: Row) => patchState(store, (s) => ({ rows: s.rows.map((r) => (r.id === row.id ? row : r)) }));

    const saveSchema = async (properties: Property[], done: string): Promise<boolean> => {
      const database = store.database();
      if (!database) return false;
      try {
        const saved = await firstValueFrom(http.put<Database>(`/api/databases/${database.id}/schema`, schemaBody(properties)));
        patchState(store, { database: saved, error: null, announcement: done });
        return true;
      } catch (error) {
        fail(error, "Couldn't change the properties");
        return false;
      }
    };

    return {
      async load(pageId: string, workspaceId: string): Promise<void> {
        patchState(store, { ...initial, status: 'loading' });
        try {
          const database = await firstValueFrom(http.get<Database>(`/api/pages/${pageId}/database`));
          patchState(store, { database });
          const [page, members] = await Promise.all([
            query(null),
            firstValueFrom(http.get<Member[]>(`/api/workspaces/${workspaceId}/members`)).catch(() => [] as Member[]),
          ]);
          patchState(store, {
            rows: page.results,
            cursor: page.next_cursor,
            hasMore: page.has_more,
            members,
            status: 'ready',
          });
        } catch (error) {
          patchState(store, { status: error instanceof HttpErrorResponse && error.status === 404 ? 'missing' : 'error' });
        }
      },

      /** Fetch the next page of rows, if there is one and none is on the way. */
      async loadMore(): Promise<void> {
        if (!store.hasMore() || store.loadingMore() || store.status() !== 'ready') return;
        patchState(store, { loadingMore: true });
        try {
          const page = await query(store.cursor());
          const known = new Set(store.rows().map((r) => r.id));
          patchState(store, (s) => ({
            rows: [...s.rows, ...page.results.filter((r) => !known.has(r.id))],
            cursor: page.next_cursor,
            hasMore: page.has_more,
          }));
        } catch (error) {
          fail(error, "Couldn't load more rows");
        } finally {
          patchState(store, { loadingMore: false });
        }
      },

      /** Change one cell: shown right away, put back if the server refuses. */
      async updateCell(rowId: string, property: Property, value: PropertyValue): Promise<void> {
        const database = store.database();
        const row = store.rows().find((r) => r.id === rowId);
        if (!database || !row) return;
        const isTitle = property.type === 'title';
        const optimistic: Row = isTitle
          ? { ...row, title: String(value ?? '') }
          : { ...row, properties: withValue(row.properties, property.id, value) };
        replaceRow(optimistic);
        try {
          const body = isTitle ? { title: String(value ?? '') } : { properties: { [property.id]: value } };
          const saved = await firstValueFrom(http.patch<Row>(`/api/databases/${database.id}/rows/${rowId}`, body));
          replaceRow(saved);
          patchState(store, { error: null });
        } catch (error) {
          replaceRow(row);
          fail(error, "Couldn't save the change");
        }
      },

      async addRow(): Promise<Row | null> {
        const database = store.database();
        if (!database) return null;
        try {
          const row = await firstValueFrom(http.post<Row>(`/api/databases/${database.id}/rows`, { title: '' }));
          patchState(store, (s) => ({ rows: [...s.rows, row], error: null, announcement: 'Row added' }));
          return row;
        } catch (error) {
          fail(error, "Couldn't add a row");
          return null;
        }
      },

      addProperty(name: string, type: PropertyType): Promise<boolean> {
        return saveSchema([...store.properties(), { id: '', name, type } as Property].map(stripNewId), 'Property added');
      },

      renameProperty(id: string, name: string): Promise<boolean> {
        const properties = store.properties().map((p) => (p.id === id ? { ...p, name } : p));
        return saveSchema(properties, 'Property renamed');
      },

      /** Change a property's type. The server clears values that no longer fit, so clear them here too. */
      async retypeProperty(id: string, type: PropertyType): Promise<boolean> {
        const properties = store.properties().map((p) => (p.id === id ? { id: p.id, name: p.name, type } : p));
        const saved = await saveSchema(properties, 'Property type changed');
        if (saved) {
          patchState(store, (s) => ({ rows: s.rows.map((r) => ({ ...r, properties: withValue(r.properties, id, null) })) }));
        }
        return saved;
      },

      dismissError(): void {
        patchState(store, { error: null });
      },
    };
  }),
);

function withValue(values: Record<string, PropertyValue>, id: string, value: PropertyValue): Record<string, PropertyValue> {
  const next = { ...values };
  const empty = value === null || value === '' || value === false || (Array.isArray(value) && value.length === 0);
  if (empty) delete next[id];
  else next[id] = value;
  return next;
}

/** New properties go without an id, so the server picks one. */
function stripNewId(property: Property): Property {
  if (property.id) return property;
  return Object.fromEntries(Object.entries(property).filter(([key]) => key !== 'id')) as unknown as Property;
}
