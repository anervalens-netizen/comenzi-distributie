'use client';
import { useState } from 'react';
import { Plus, Search, Pencil, Trash2, Save, RefreshCw } from 'lucide-react';
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
import { api, errorMessage, normalize, money } from '@/lib/client-api';
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
    [error, setError] = useState('');
  const categories = [
    ...new Set(
      products
        .filter((p) => kind === 'all' || p.kind === kind)
        .map((p) => p.category),
    ),
  ].sort((a, b) => a.localeCompare(b, 'ro'));
  const filtered = products.filter(
    (p) =>
      (kind === 'all' || p.kind === kind) &&
      (category === 'all' || p.category === category) &&
      normalize(
        p.code +
          ' ' +
          (p.eans || [p.ean]).join(' ') +
          ' ' +
          p.name +
          ' ' +
          p.brand,
      ).includes(normalize(query)),
  );
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
    if (!edit || busy) return;
    await change(edit.id ? 'PUT' : 'POST', edit);
  }
  async function change(method: 'POST' | 'PUT' | 'DELETE', product: Product) {
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
            onClick={() => {
              setEdit({ ...empty });
              setError('');
            }}
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
            {categories.flatMap((c) => {
              const items = filtered.filter((p) => p.category === c);
              return items.length
                ? [
                    <TableRow
                      className="catalog-group-row"
                      key={'category-' + c}
                    >
                      <TableCell colSpan={6}>
                        <strong>{c}</strong> · {items.length} produse
                      </TableCell>
                    </TableRow>,
                    ...items.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          {p.code}
                          {p.ean && <small>EAN: {p.ean}</small>}
                        </TableCell>
                        <TableCell>
                          <button type="button" className="catalog-product-name" onClick={() => { setEdit({ ...p }); setError(''); }}>
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
                              onClick={() => {
                                setEdit({ ...p });
                                setError('');
                              }}
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
          if (!open && !busy) setEdit(null);
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
              </fieldset>
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
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
