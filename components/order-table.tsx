'use client';
import { ArrowUpRight, Copy, FileSpreadsheet, ScanBarcode, Package, Trash2 } from 'lucide-react';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { dateLabel, timeLabel, kindLabels, money, orderEffectiveDate } from '@/lib/client-api';
import type { Order } from '@/lib/types';
export function OrderTable({orders,onOpen,onCopy,onDelete,manager=false}:{orders:Order[];onOpen:(o:Order)=>void;onCopy:(o:Order)=>void;onDelete?:(o:Order)=>void;manager?:boolean}) {
  if(!orders.length) return <Empty className="empty-orders"><EmptyHeader><EmptyMedia><FileSpreadsheet size={32}/></EmptyMedia><EmptyTitle>Nicio comandă aici, deocamdată</EmptyTitle><EmptyDescription>Comenzile salvate și finalizate vor apărea în această listă.</EmptyDescription></EmptyHeader></Empty>;
  return <Table className="orders-table"><TableHeader><TableRow><TableHead>COMANDĂ</TableHead><TableHead>{manager?'AGENT / CLIENT':'CLIENT / GESTIUNE'}</TableHead><TableHead>DATA / ORA</TableHead><TableHead>CANTITATE</TableHead><TableHead>STATUS</TableHead><TableHead className="text-right">ACȚIUNI</TableHead></TableRow></TableHeader><TableBody>{orders.map(o=><TableRow key={o.id}>
    <TableCell><button className="order-link" onClick={()=>onOpen(o)}><span className={'row-type '+o.kind}>{o.kind==='sim'?<ScanBarcode size={18}/>:<Package size={18}/>}</span><span><strong>{o.number}</strong><small>{kindLabels[o.kind]}</small></span></button></TableCell>
    <TableCell><strong className="cell-name">{manager?o.agentName:o.client?.name||o.warehouseName.replace(/^gestiune\s+/i,'')}</strong><small>{manager?(o.client?.name||o.warehouseName.replace(/^gestiune\s+/i,'')):(o.client?.city||'Comandă pentru stoc')}</small></TableCell>
    <TableCell><time dateTime={orderEffectiveDate(o)} title={o.finalizedAt?'Finalizat · ora României':'Creat · ora României'}>{dateLabel(orderEffectiveDate(o))}<small>{timeLabel(orderEffectiveDate(o))}</small></time></TableCell><TableCell><strong>{o.pieces} {o.kind==='sim'?'SIM':'buc.'}</strong><small>{o.kind==='accessories'?money(o.total):(o.kind==='stands'||o.kind==='stand_client')?`${(o.itemCount??o.items.length)} produse`:o.kind==='combined'?`${o.itemCount??(o.items.length+(o.standItems||[]).length)} produse`:'sim 0 vodafone'}</small></TableCell>
    <TableCell><span className={'badge '+o.status}><span/>{o.status==='draft'?'Ciornă':'Finalizată'}</span></TableCell>
    <TableCell><div className="table-actions">{onDelete&&(manager||o.status==='draft')&&<button className="icon-button delete-order" onClick={()=>onDelete(o)} title={o.status==='draft'?'Renunță la ciornă':'Șterge comanda'} aria-label={`${o.status==='draft'?'Renunță la ciornă':'Șterge'} ${o.number}`}><Trash2 size={18}/></button>}<button className="icon-button" onClick={()=>onCopy(o)} title="Copiază comanda" aria-label={`Copiază ${o.number}`}><Copy size={18}/></button><button className="icon-button" onClick={()=>onOpen(o)} title="Deschide comanda" aria-label={`Deschide ${o.number}`}><ArrowUpRight size={19}/></button></div></TableCell>
  </TableRow>)}</TableBody></Table>;
}

