'use client';
import { useMemo, useState } from 'react';
import Image from 'next/image';
import { Plus, Search, Pencil, Trash2, Save, RefreshCw, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Choice } from './choice';
import { ListPagination, useListPage } from './list-pagination';
import { api, errorMessage, normalize, money } from '@/lib/client-api';
import { maxProductPhotoBase64, maxProductPhotoSide, productPhotoMime, productPhotoPrefix } from '@/lib/product-photo';
import type { Product } from '@/lib/types';
const empty: Product = {
  id: '',
  code: '',
  name: '',
  brand: '',
  category: '',
  kind: 'accessories',
  price: null,
  netPrice: null,
  sourceRow: 0,
  image: null,
};
export function ProductCatalog({
  products,
  onProducts,
}: {
  products: Product[];
  onProducts: (p: Product[]) => void;
}) {
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [category, setCategory] = useState('all'),
    [edit, setEdit] = useState<Product | null>(null),
    [remove, setRemove] = useState<Product | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [photoDraft, setPhotoDraft] = useState(''),
    [photoError, setPhotoError] = useState(''),
    [preparingPhoto, setPreparingPhoto] = useState(false);
  const categories = useMemo(() => [
    ...new Set(
      products
        .filter((p) => kind === 'all' || p.kind === kind)
        .map((p) => p.category),
    ),
  ].sort((a, b) => a.localeCompare(b, 'ro')), [products, kind]);
  const searchIndex = useMemo(() => new Map(products.map(p => [p.id, normalize(
    p.code + ' ' + (p.eans || [p.ean]).join(' ') + ' ' + p.name + ' ' + p.brand,
  )])), [products]);
  const normalizedQuery = normalize(query);
  const filtered = useMemo(() => products.filter(
    (p) =>
      (kind === 'all' || p.kind === kind) &&
      (category === 'all' || p.category === category) &&
      searchIndex.get(p.id)!.includes(normalizedQuery),
  ), [products, kind, category, searchIndex, normalizedQuery]);
  // Retain the previous category/input ordering and full category totals; only
  // the current page of products becomes DOM rows.
  const grouped = useMemo(() => {
    const groups = new Map<string, Product[]>();
    for (const product of filtered) {
      const items = groups.get(product.category);
      if (items) items.push(product);
      else groups.set(product.category, [product]);
    }
    return groups;
  }, [filtered]);
  const ordered = useMemo(() => categories.flatMap(c => grouped.get(c) || []), [categories, grouped]);
  const pagination = useListPage(ordered.length, JSON.stringify([query, kind, category]));
  const shown = ordered.slice(pagination.start, pagination.end);
  const shownGroups = new Map<string, Product[]>();
  for (const product of shown) {
    const items = shownGroups.get(product.category);
    if (items) items.push(product);
    else shownGroups.set(product.category, [product]);
  }
  async function refresh() {
    setBusy(true);
    try {
      onProducts(
        (await api<{ products: Product[] }>('admin/products')).products,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!edit || busy || preparingPhoto) return;
    await change(edit.id ? 'PUT' : 'POST', {
      ...edit,
      ...(photoDraft && { photo: photoDraft.slice(productPhotoPrefix.length) }),
    });
  }
  function openEdit(product: Product) {
    setEdit({ ...product });
    setError('');
    setPhotoDraft('');
    setPhotoError('');
  }
  async function selectPhoto(file: File) {
    setPhotoError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setPhotoError('Alege o imagine JPG, PNG sau WebP de maximum 10 MB.');
      return;
    }
    setPreparingPhoto(true);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxProductPhotoSide / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error();
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let preview = canvas.toDataURL(productPhotoMime, 0.84);
        const maxLength = productPhotoPrefix.length + maxProductPhotoBase64;
        if (preview.length > maxLength) preview = canvas.toDataURL(productPhotoMime, 0.60);
        if (!preview.startsWith(productPhotoPrefix) || preview.length > maxLength) throw new Error();
        setPhotoDraft(preview);
      } finally {
        bitmap.close();
      }
    } catch {
      setPhotoError('Poza nu a putut fi pregătită. Alege o altă imagine.');
    } finally {
      setPreparingPhoto(false);
    }
  }
  async function change(method: 'POST' | 'PUT' | 'DELETE', product: Product & { photo?: string }) {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ products: Product[] }>(
        `admin/products${product.id ? '/' + encodeURIComponent(product.id) : ''}`,
        method,
        product,
      );
      onProducts(r.products);
      setEdit(null);
      setRemove(null);
      toast.success(
        method === 'DELETE'
          ? 'Produsul a fost șters din catalog.'
          : 'Catalogul a fost actualizat.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const editCategories = edit
    ? [
        ...new Set(
          products.filter((p) => p.kind === edit.kind).map((p) => p.category),
        ),
      ].sort((a, b) => a.localeCompare(b, 'ro'))
    : [];
  const knownEditCategory = !!edit && editCategories.includes(edit.category);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Catalog produse</h1>
          <p>{products.length} produse disponibile pentru comenzi.</p>
        </div>
        <div className="heading-controls">
          <button
            className="icon-button"
            aria-label="Actualizează catalogul"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={19} />
          </button>
          <button
            className="primary"
            onClick={() => openEdit(empty)}
          >
            <Plus size={18} /> Produs nou
          </button>
        </div>
      </div>
      <section className="panel">
        <div className="panel-toolbar">
          <div className="search-box">
            <Search size={18} />
            <input
              aria-label="Caută produs după cod, EAN sau denumire"
              placeholder="Caută cod, EAN, denumire sau marcă…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Choice
            label="Tip produse"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setCategory('all');
            }}
            options={[
              { value: 'all', label: 'Toate tipurile' },
              { value: 'accessories', label: 'Accesorii' },
              { value: 'stands', label: 'Standuri, cartele, telefoane' },
            ]}
          />
          <Choice
            label="Categorie produse"
            value={category}
            onChange={setCategory}
            options={[
              { value: 'all', label: 'Toate categoriile' },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
          />
        </div>
        <ListPagination count={ordered.length} {...pagination} onPage={pagination.setPage} label="Pagini catalog produse"/>
        <Table className="orders-table catalog-admin-table">
          <TableHeader>
            <TableRow>
              <TableHead>COD</TableHead>
              <TableHead>PRODUS / MARCĂ</TableHead>
              <TableHead>TIP</TableHead>
              <TableHead>FĂRĂ TVA</TableHead>
              <TableHead>CU TVA</TableHead>
              <TableHead>ACȚIUNI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...shownGroups].flatMap(([c, items]) => {
              return items.length
                ? [
                    <TableRow
                      className="catalog-group-row"
                      key={'category-' + c}
                    >
                      <TableCell colSpan={6}>
                        <strong>{c}</strong> · {grouped.get(c)!.length} produse
                      </TableCell>
                    </TableRow>,
                    ...items.map((p) => (
                      <TableRow key={p.id} data-product-id={p.id}>
                        <TableCell>
                          {p.code}
                          {p.ean && <small>EAN: {p.ean}</small>}
                        </TableCell>
                        <TableCell>
                          <button type="button" className="catalog-product-name" onClick={() => openEdit(p)}>
                            <strong>{p.name}</strong>
                          </button>
                          <small>{p.brand}</small>
                        </TableCell>
                        <TableCell>
                          {p.kind === 'accessories'
                            ? 'Accesorii'
                            : 'Standuri / cartele'}
                        </TableCell>
                        <TableCell>
                          {p.netPrice === null ? '—' : money(p.netPrice)}
                        </TableCell>
                        <TableCell>
                          {p.price === null ? '—' : money(p.price)}
                        </TableCell>
                        <TableCell>
                          <div className="table-actions">
                            <button
                              className="icon-button"
                              aria-label={`Editează ${p.code}`}
                              onClick={() => openEdit(p)}
                            >
                              <Pencil size={18} />
                            </button>
                            <button
                              className="icon-button delete-order"
                              aria-label={`Șterge ${p.code}`}
                              onClick={() => {
                                setRemove(p);
                                setError('');
                              }}
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )),
                  ]
                : [];
            })}
          </TableBody>
        </Table>
        {!filtered.length && (
          <p className="portfolio-message">
            Niciun produs nu corespunde filtrelor.
          </p>
        )}
      </section>
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open && !busy && !preparingPhoto) setEdit(null);
        }}
      >
        <DialogContent className="admin-dialog client-edit-dialog">
          <DialogHeader>
            <DialogTitle>
              {edit?.id ? 'Editează produsul' : 'Produs nou'}
            </DialogTitle>
            <DialogDescription>
              Modificările se aplică comenzilor viitoare. Produsele adăugate
              aici apar în foaia „Produse suplimentare” a Excelului.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <form className="form-stack" onSubmit={(e) => void save(e)}>
              <fieldset className="client-fields" disabled={busy}>
                <label className="client-wide">
                  Tip
                  <select
                    disabled={!!edit.id}
                    value={edit.kind}
                    onChange={(e) =>
                      setEdit((p) =>
                        p ? { ...p, kind: e.target.value, category: '' } : p,
                      )
                    }
                  >
                    <option value="accessories">Accesorii</option>
                    <option value="stands">
                      Standuri, cartele și telefoane
                    </option>
                  </select>
                </label>
                {(
                  [
                    ['code', 'Cod produs', 80],
                    ['ean', 'EAN', 14],
                    ['name', 'Denumire', 300],
                    ['brand', 'Marcă', 100],
                  ] as const
                ).map(([key, label, max]) => (
                  <label
                    key={key}
                    className={key === 'name' ? 'client-wide' : undefined}
                  >
                    {label}
                    <input
                      required={key === 'code' || key === 'name'}
                      inputMode={key === 'ean' ? 'numeric' : undefined}
                      maxLength={max}
                      value={edit[key] ?? ''}
                      onChange={(e) =>
                        setEdit((p) =>
                          p ? { ...p, [key]: e.target.value } : p,
                        )
                      }
                    />
                  </label>
                ))}
                <label className="category-editor client-wide">
                  Mută în categoria
                  <select
                    aria-label="Mută produsul în categoria"
                    value={knownEditCategory ? edit.category : '__custom'}
                    onChange={(e) =>
                      setEdit((p) =>
                        p
                          ? {
                              ...p,
                              category:
                                e.target.value === '__custom'
                                  ? ''
                                  : e.target.value,
                            }
                          : p,
                      )
                    }
                  >
                    <option value="">Alege o categorie</option>
                    {editCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    <option value="__custom">Categorie nouă</option>
                  </select>
                  {(!knownEditCategory || !edit.id) && (
                    <input
                      required
                      maxLength={100}
                      value={edit.category}
                      placeholder="Nume categorie nouă"
                      onChange={(e) =>
                        setEdit((p) =>
                          p ? { ...p, category: e.target.value } : p,
                        )
                      }
                    />
                  )}
                </label>
                {(
                  [
                    ['netPrice', 'Preț fără TVA'],
                    ['price', 'Preț cu TVA'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="any"
                      required={edit.kind === 'accessories'}
                      value={edit[key] ?? ''}
                      onChange={(e) =>
                        setEdit((p) =>
                          p
                            ? {
                                ...p,
                                [key]:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              }
                            : p,
                        )
                      }
                    />
                  </label>
                ))}
                <div className="catalog-photo-editor client-wide">
                  {photoDraft || edit.image ? (
                    <Image unoptimized width={88} height={78} className="catalog-photo-preview" src={photoDraft || edit.image || ''} alt="Previzualizare poză produs" />
                  ) : (
                    <span className="catalog-photo-preview catalog-photo-empty">
                      <ImageIcon size={22} aria-hidden="true" /> Fără poză
                    </span>
                  )}
                  <div className="catalog-photo-controls">
                    <label>
                      {photoDraft || edit.image ? 'Înlocuiește poza produsului' : 'Adaugă poza produsului'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={preparingPhoto}
                        aria-describedby="catalog-photo-hint"
                        onChange={(e) => {
                          const file = e.currentTarget.files?.[0];
                          e.currentTarget.value = '';
                          if (file) void selectPhoto(file);
                        }}
                      />
                    </label>
                    <small id="catalog-photo-hint">JPG, PNG sau WebP · maximum 10 MB</small>
                    {preparingPhoto && <output>Se pregătește poza…</output>}
                    {photoError && <small className="catalog-photo-error" role="alert">{photoError}</small>}
                    {photoDraft && (
                      <button
                        type="button"
                        className="catalog-photo-reset"
                        disabled={preparingPhoto}
                        onClick={() => { setPhotoDraft(''); setPhotoError(''); }}
                      >
                        Renunță la poza selectată
                      </button>
                    )}
                  </div>
                </div>
              </fieldset>
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy || preparingPhoto}>
                <Save size={18} />
                {busy ? 'Se salvează…' : 'Salvează produsul'}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !busy) setRemove(null);
        }}
      >
        <DialogContent className="admin-dialog">
          <DialogHeader>
            <DialogTitle>Ștergi produsul {remove?.code}?</DialogTitle>
            <DialogDescription>
              {remove?.name}. Produsul nu va mai putea fi comandat. Comenzile
              finalizate rămân neschimbate.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <div className="delete-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              Renunță
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => remove && void change('DELETE', remove)}
            >
              Șterge produsul
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
