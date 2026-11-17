export type Stroke = { x: number; y: number }[];
export type EmployeeProfile = {
  approvers: { id: string; email: string }[];
  userId: string;
  legalName: string;
  employer: string;
  email: string;
  approverId: string | null;
  approverEmail: string;
  holidayCalendar: 'orthodox' | 'western';
  extraHolidays: string[];
  verified: boolean;
  revision: number;
};
export type LeaveSnapshot = {
  approvers?: { id: string; name: string; email: string }[];
  legalName: string;
  employer: string;
  approverName: string;
  approverEmail: string;
  to: string;
  workingDates: string[];
  excludedDates: string[];
  calendar: string;
  profileRevision: number;
};
export type LeaveRecord = {
  id: string;
  agentId: string;
  approverId: string;
  startDate: string;
  endDate: string;
  days: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  snapshot: LeaveSnapshot;
  signedAt: string | null;
  submittedAt: string | null;
  decisionNote: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  canDecide: boolean;
};
export type LeaveEvent = {
  id: string;
  action: string;
  note: string;
  createdAt: string;
  actorName: string;
};
export const leaveStatus = {
  draft: 'Ciornă',
  submitted: 'În așteptare',
  approved: 'Aprobată',
  rejected: 'Respinsă',
  cancelled: 'Anulată',
};
export type NotificationItem = {
  id: string;
  category: string;
  title: string;
  body: string;
  targetType: string;
  targetId: string;
  createdAt: string;
  readAt: string | null;
};
export type NotificationFeed = {
  items: NotificationItem[];
  unread: number;
  total: number;
  hasMore: boolean;
};
