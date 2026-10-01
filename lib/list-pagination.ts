export const LIST_PAGE_SIZE = 40;

export function listPage(count: number, requestedPage: number, pageSize = LIST_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const start = page * pageSize;
  return { page, pages, start, end: Math.min(start + pageSize, count) };
}
