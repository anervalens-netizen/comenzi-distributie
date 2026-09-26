'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SalesView } from '@/lib/sales-types';
import { money } from '@/lib/client-api';

export default function SalesChart({ daily }: { daily: SalesView['daily'] }) {
  const chartData = daily.map(day => ({ ...day, label: new Date(`${day.date}T00:00:00+02:00`).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: 'short' }) }));
  return <div className="sales-chart"><ResponsiveContainer width="100%" height={250}><BarChart data={chartData} margin={{ top: 8, right: 16, left: 2, bottom: 8 }}><CartesianGrid stroke="#edf0f3" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fill: '#687383', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#dfe3e9' }}/><YAxis yAxisId="quantity" tick={{ fill: '#687383', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={value => Number(value).toLocaleString('ro-RO')}/><YAxis yAxisId="value" orientation="right" tick={{ fill: '#687383', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={value => `${Math.round(Number(value) / 1000)}k`}/><Tooltip labelFormatter={label => String(label)} formatter={(value, name) => [name === 'Valoare' ? money(Number(value)) : Number(value).toLocaleString('ro-RO'), name]}/><Legend wrapperStyle={{ fontSize: 11, color: '#687383' }}/><Bar yAxisId="quantity" dataKey="quantity" name="Cantitate" fill="#e52430" radius={[4, 4, 0, 0]} maxBarSize={34}/><Bar yAxisId="value" dataKey="value" name="Valoare" fill="#e3a0a6" radius={[4, 4, 0, 0]} maxBarSize={34}/></BarChart></ResponsiveContainer></div>;
}
