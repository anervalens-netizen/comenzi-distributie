import {z} from 'zod';

const label = z.string().trim().min(1).max(96);
const cell = z.string().max(360);
export const presentationSchema = z.strictObject({
  title: label,
  layout: z.enum(['table', 'steps', 'facts']),
  columns: z.array(label).min(1).max(8),
  rows: z.array(z.array(cell).min(1).max(8)).min(1).max(24),
}).refine(data => data.rows.every(row => row.length === data.columns.length)
  && (data.layout === 'table' || data.columns.length === 2)
  && JSON.stringify(data).length <= 16000, 'Dimensiunile fișei sunt invalide.');

export type ManagerPresentation = z.infer<typeof presentationSchema>;

export const presentationTool = {
  name: 'present_information',
  description: 'Prezintă informații într-o fișă vizuală în chat, independent de subiect sau de export. Folosește table pentru comparații, steps pentru pași și facts pentru indicatori sau perechi etichetă–valoare. Pentru steps și facts trimite două coloane. Fiecare rând are același număr de celule ca antetul. O fișă per răspuns.',
  parameters: {
    type: 'object' as const,
    properties: {
      title: {type:'string'},
      layout: {type:'string', enum:['table','steps','facts']},
      columns: {type:'array', items:{type:'string'}},
      rows: {type:'array', items:{type:'array',items:{type:'string'}}},
    },
    required:['title','layout','columns','rows'],
    additionalProperties:false,
  },
};

export function parsePresentation(raw: string): ManagerPresentation | undefined {
  if (raw.length > 32000) return undefined;
  try {
    return presentationSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}
