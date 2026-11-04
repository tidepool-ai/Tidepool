import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';

/** A page as returned by /api/pages (T06). */
export interface ApiPage {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
}

interface ApiWorkspace {
  id: string;
  name: string;
}

export interface TreePage {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
}

/** Key for the top level in `children`. */
export const ROOT = '';

interface PageTreeState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  workspaceId: string | null;
  pages: Record<string, TreePage>;
  /** Child ids per parent id (ROOT for the top level). Missing = not loaded yet. */
  children: Record<string, string[]>;
  expanded: Record<string, boolean>;
  /** Page whose title is being edited inline. */
  renamingId: string | null;
  /** Latest message for the screen-reader live region. */
  announcement: string;
}

const initialState: PageTreeState = {
  status: 'idle',
  workspaceId: null,
  pages: {},
  children: {},
  expanded: {},
  renamingId: null,
  announcement: '',
};

export function pageTitle(page: Pick<TreePage, 'title'> | undefined): string {
  return page?.title.trim() || 'Untitled';
}

function toTreePage(page: ApiPage): TreePage {
  return { id: page.id, parentId: page.parent_id, title: page.title, icon: page.icon };
}

/**
 * Sidebar page tree for the user's first workspace (a workspace switcher comes later).
 * Each level is fetched the first time it is expanded.
 */
export const PageTreeStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, http = inject(HttpClient)) => {
    const addPages = (parentKey: string, pages: ApiPage[]) =>
      patchState(store, (state) => ({
        pages: { ...state.pages, ...Object.fromEntries(pages.map((p) => [p.id, toTreePage(p)])) },
        children: { ...state.children, [parentKey]: pages.map((p) => p.id) },
      }));

    const announce = (announcement: string) => patchState(store, { announcement });

    async function loadChildren(parentId: string): Promise<void> {
      try {
        addPages(parentId, await firstValueFrom(http.get<ApiPage[]>(`/api/pages/${parentId}/children`)));
      } catch {
        patchState(store, (state) => ({ expanded: { ...state.expanded, [parentId]: false } }));
        announce("Couldn't load subpages");
      }
    }

    async function toggle(id: string): Promise<void> {
      const expand = !store.expanded()[id];
      patchState(store, (state) => ({ expanded: { ...state.expanded, [id]: expand } }));
      if (expand && !store.children()[id]) await loadChildren(id);
    }

    return {
      async load(): Promise<void> {
        if (store.status() === 'loading' || store.status() === 'ready') return;
        patchState(store, { status: 'loading' });
        try {
          const [workspace] = await firstValueFrom(http.get<ApiWorkspace[]>('/api/workspaces'));
          if (!workspace) throw new Error('no workspace');
          const pages = await firstValueFrom(http.get<ApiPage[]>(`/api/workspaces/${workspace.id}/pages`));
          patchState(store, { workspaceId: workspace.id, status: 'ready' });
          addPages(ROOT, pages);
        } catch {
          patchState(store, { status: 'error' });
        }
      },

      toggle,

      /** Create an untitled page (top level, or inside `parentId`) and start renaming it. */
      async create(parentId: string | null): Promise<TreePage | null> {
        const workspaceId = store.workspaceId();
        if (!workspaceId) return null;
        try {
          const page = await firstValueFrom(
            http.post<ApiPage>('/api/pages', { workspace_id: workspaceId, parent_id: parentId }),
          );
          const key = parentId ?? ROOT;
          const siblings = store.children()[key];
          patchState(store, (state) => ({
            pages: { ...state.pages, [page.id]: toTreePage(page) },
            // An unloaded parent gets its full list (including the new page) when it expands below.
            children: siblings ? { ...state.children, [key]: [...siblings, page.id] } : state.children,
            renamingId: page.id,
          }));
          if (parentId && !store.expanded()[parentId]) await toggle(parentId);
          announce('Page created');
          return toTreePage(page);
        } catch {
          announce("Couldn't create the page");
          return null;
        }
      },

      startRename(id: string): void {
        patchState(store, { renamingId: id });
      },

      stopRename(): void {
        patchState(store, { renamingId: null });
      },

      /** Save a new title, updating the tree right away and rolling back if the server refuses. */
      async rename(id: string, title: string): Promise<void> {
        const page = store.pages()[id];
        patchState(store, { renamingId: null });
        if (!page || page.title === title) return;
        const setTitle = (value: string) =>
          patchState(store, (state) => ({ pages: { ...state.pages, [id]: { ...page, title: value } } }));
        setTitle(title);
        try {
          await firstValueFrom(http.patch<ApiPage>(`/api/pages/${id}`, { title }));
          announce(`Renamed to ${pageTitle({ title })}`);
        } catch {
          setTitle(page.title);
          announce("Couldn't rename the page");
        }
      },

      /** Show a title saved elsewhere (e.g. the page view) in the tree, if the page is loaded. */
      applyTitle(id: string, title: string): void {
        const page = store.pages()[id];
        if (page) patchState(store, (state) => ({ pages: { ...state.pages, [id]: { ...page, title } } }));
      },

      /** Move a page (and its subpages) to the trash. Returns false if the server refused. */
      async trash(id: string): Promise<boolean> {
        const page = store.pages()[id];
        if (!page) return false;
        try {
          await firstValueFrom(http.delete(`/api/pages/${id}`));
        } catch {
          announce("Couldn't move the page to the trash");
          return false;
        }
        const key = page.parentId ?? ROOT;
        patchState(store, (state) => ({
          children: { ...state.children, [key]: (state.children[key] ?? []).filter((c) => c !== id) },
        }));
        announce(`Moved ${pageTitle(page)} to the trash`);
        return true;
      },

      /** True if `pageId` is `ancestorId` or somewhere below it in the loaded tree. */
      isWithin(pageId: string, ancestorId: string): boolean {
        for (let id: string | null = pageId; id; id = store.pages()[id]?.parentId ?? null) {
          if (id === ancestorId) return true;
        }
        return false;
      },

      /** Forget everything, e.g. on sign-out, so the next user starts fresh. */
      reset(): void {
        patchState(store, initialState);
      },
    };
  }),
);
