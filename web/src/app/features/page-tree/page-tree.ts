import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { PageTreeItem } from './page-tree-item';
import { PageTreeStore, ROOT } from './page-tree.store';

/** "Private" section of the spaces panel: the workspace's page tree. */
@Component({
  selector: 'app-page-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageTreeItem],
  templateUrl: './page-tree.html',
  styleUrl: './page-tree.scss',
})
export class PageTree implements OnInit {
  protected readonly store = inject(PageTreeStore);
  protected readonly ROOT = ROOT;

  ngOnInit(): void {
    void this.store.load();
  }

  protected retry(): void {
    this.store.reset();
    void this.store.load();
  }
}
