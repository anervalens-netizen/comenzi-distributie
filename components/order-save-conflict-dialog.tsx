'use client';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { orderConflictLabels, type OrderConflictChoice } from '@/lib/order-draft';
import type { PendingOrderConflict } from '@/components/use-order-draft-save';

export function OrderSaveConflictDialog({conflict,onResolve}:{conflict:PendingOrderConflict|null;onResolve:(choice:OrderConflictChoice)=>void}) {
  return <Dialog open={!!conflict} onOpenChange={()=>{}}><DialogContent showCloseButton={false} className="review-dialog"><DialogHeader><DialogTitle className="text-xl"><AlertTriangle size={24}/> Comanda a fost modificată în două locuri</DialogTitle><DialogDescription>Schimbările care nu se suprapun au fost combinate automat.</DialogDescription></DialogHeader>
    <div className="review-content"><p>Alege varianta pentru {conflict?.fields.map(field=>orderConflictLabels[field]).join(', ')}. Celelalte modificări rămân păstrate indiferent de alegere.</p><p className="muted">„Modificările mele” va salva ulterior valorile de pe acest dispozitiv peste câmpurile aflate în conflict. „Versiunea serverului” păstrează valorile salvate de cealaltă sesiune.</p></div>
    <div className="dialog-actions"><button className="secondary" onClick={()=>onResolve('remote')}>Folosește versiunea serverului</button><button className="primary" onClick={()=>onResolve('local')}>Păstrează modificările mele</button></div>
  </DialogContent></Dialog>;
}
