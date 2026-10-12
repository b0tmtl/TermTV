// Promise-based clients for the library and search workers.

import type { LibraryRequest, LibraryResponse, SearchRequest, SearchResponse } from '@/workers/protocol';

/** Omit that distributes over a union of message types. */
type Without<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

type Pending<R> = { resolve: (r: R) => void; reject: (e: Error) => void; onProgress?: (r: R) => void };

class WorkerClient<Req extends { id: number }, Res extends { id: number; type: string }> {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending<Res>>();

  constructor(url: string) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent) => {
      const res = e.data as Res;
      const p = this.pending.get(res.id);
      if (!p) return;
      if (res.type === 'progress') {
        if (p.onProgress) p.onProgress(res);
        return;
      }
      this.pending.delete(res.id);
      if (res.type === 'error') p.reject(new Error((res as unknown as { message: string }).message));
      else p.resolve(res);
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Worker error');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };
  }

  call(req: Without<Req, 'id'>, onProgress?: (r: Res) => void, transfer?: Transferable[]): Promise<Res> {
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...req, id }, transfer || []);
    });
  }
}

let lib: WorkerClient<LibraryRequest, LibraryResponse> | null = null;
let search: WorkerClient<SearchRequest, SearchResponse> | null = null;

export function libraryWorker(): WorkerClient<LibraryRequest, LibraryResponse> {
  return lib || (lib = new WorkerClient('js/workers/library.worker.js'));
}

export function searchWorker(): WorkerClient<SearchRequest, SearchResponse> {
  return search || (search = new WorkerClient('js/workers/search.worker.js'));
}
