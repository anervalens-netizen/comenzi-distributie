import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), username: text('username').notNull().unique(), name: text('name').notNull(),
  role: text('role').notNull(), managerScope: text('manager_scope').notNull().default('assigned'), warehouseId: text('warehouse_id'), warehouseName: text('warehouse_name'), siteCode: text('site_code').notNull().default(''), passwordHash: text('password_hash').notNull(),
  mustChangePassword: integer('must_change_password').notNull().default(1), active: integer('active').notNull().default(1),
});
export const managerAgents = sqliteTable('manager_agents', {
  managerId: text('manager_id').notNull().references(() => users.id), agentId: text('agent_id').notNull().references(() => users.id),
}, t => [primaryKey({ columns: [t.managerId, t.agentId] }), index('idx_manager_agents_agent').on(t.agentId)]);
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id), expiresAt: integer('expires_at').notNull(),
}, t => [index('idx_sessions_user').on(t.userId)]);
export const settings = sqliteTable('settings', { key: text('key').primaryKey(), value: text('value').notNull() });
export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(), warehouseId: text('warehouse_id').notNull(), data: text('data').notNull(), active: integer('active').notNull().default(1),
}, t => [index('idx_customers_warehouse').on(t.warehouseId)]);
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(), number: text('number').notNull().unique(), userId: text('user_id').notNull().references(() => users.id),
  warehouseId: text('warehouse_id').notNull(), kind: text('kind').notNull(), status: text('status').notNull(), payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(), finalizedAt: text('finalized_at'), weekKey: text('week_key'), sourceOrderId: text('source_order_id'),
  revision: integer('revision').notNull().default(1),
}, t => [index('idx_orders_user_created').on(t.userId, t.createdAt), index('idx_orders_week').on(t.userId,t.kind,t.weekKey,t.status)]);
export const serials = sqliteTable('serials', {
  serial: text('serial').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id),
}, t => [index('idx_serials_order').on(t.orderId)]);
export const partnerRequests = sqliteTable('partner_requests', {
  id: text('id').primaryKey(), agentId: text('agent_id').notNull().references(() => users.id), warehouseId: text('warehouse_id').notNull(),
  cuiKey: text('cui_key').notNull(), status: text('status').notNull().default('requested'), payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), confirmedAt: text('confirmed_at'), confirmedBy: text('confirmed_by').references(() => users.id), customerId: text('customer_id'), revision: integer('revision').notNull().default(1),
}, t => [index('idx_partner_requests_agent_created').on(t.agentId,t.createdAt), index('idx_partner_requests_status_created').on(t.status,t.createdAt), index('idx_partner_requests_cui').on(t.cuiKey)]);
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  p256dh: text('p256dh').notNull(), auth: text('auth').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [index('idx_push_subscriptions_user').on(t.userId)]);
export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(), attempts: integer('attempts').notNull(), resetAt: integer('reset_at').notNull(),
});
// Readable export of the old private preview's order payloads during migration.
export const orderPayloadArchive = sqliteTable('order_payload_archive', {
  orderId: text('order_id').notNull(), chunkIndex: integer('chunk_index').notNull(), chunk: text('chunk').notNull(),
}, t => [primaryKey({ columns: [t.orderId, t.chunkIndex] })]);

export const partnerProfiles = sqliteTable('partner_profiles', {
  customerId: text('customer_id').primaryKey().references(() => customers.id),
  contact: text('contact').notNull().default(''), phone: text('phone').notNull().default(''), email: text('email').notNull().default(''),
  latitude: real('latitude'), longitude: real('longitude'), positionSource: text('position_source'), positionAccuracy: real('position_accuracy'), positionProvider: text('position_provider'), positionMetadata: text('position_metadata'),
  addressFingerprint: text('address_fingerprint').notNull().default(''), revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(), updatedBy: text('updated_by').references(() => users.id),
}, t => [index('idx_partner_profiles_coordinates').on(t.latitude,t.longitude,t.customerId)]);
export const partnerVisits = sqliteTable('partner_visits', {
  id: text('id').primaryKey(), customerId: text('customer_id').notNull().references(() => customers.id),
  agentId: text('agent_id').notNull().references(() => users.id), agentName: text('agent_name').notNull(),
  visitedAt: text('visited_at').notNull(), notes: text('notes').notNull().default(''), nextStep: text('next_step').notNull().default(''), followUpDate: text('follow_up_date'), createdAt: text('created_at').notNull(),
}, t => [index('idx_partner_visits_customer_date').on(t.customerId,t.visitedAt,t.id), index('idx_partner_visits_agent_date').on(t.agentId,t.visitedAt), index('idx_partner_visits_follow_up').on(t.followUpDate,t.agentId,t.customerId)]);

export const partnerDayPlans = sqliteTable('partner_day_plans', {
 agentId: text('agent_id').notNull().references(() => users.id),
 planDate: text('plan_date').notNull(),
 stops: text('stops').notNull().default('[]'),
 revision: integer('revision').notNull().default(1),
 updatedAt: text('updated_at').notNull(),
}, t => [primaryKey({columns:[t.agentId,t.planDate]})]);

export const employeeProfiles = sqliteTable('employee_profiles', {
 approvers:text('approvers').notNull().default('[]'),userId:text('user_id').primaryKey().references(()=>users.id),legalName:text('legal_name').notNull(),employer:text('employer').notNull().default(''),
 email:text('email').notNull().default(''),approverId:text('approver_id').references(()=>users.id),approverEmail:text('approver_email').notNull().default(''),
 holidayCalendar:text('holiday_calendar').notNull().default('orthodox'),extraHolidays:text('extra_holidays').notNull().default('[]'),verified:integer('verified').notNull().default(0),
 revision:integer('revision').notNull().default(1),updatedAt:text('updated_at').notNull(),
});
export const leaveRequests = sqliteTable('leave_requests', {
 id:text('id').primaryKey(),agentId:text('agent_id').notNull().references(()=>users.id),approverId:text('approver_id').notNull().references(()=>users.id),
 startDate:text('start_date').notNull(),endDate:text('end_date').notNull(),days:integer('days').notNull(),status:text('status').notNull(),snapshot:text('snapshot').notNull(),
 signature:text('signature'),signedAt:text('signed_at'),submittedAt:text('submitted_at'),decisionNote:text('decision_note').notNull().default(''),
 createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),revision:integer('revision').notNull().default(1),
},t=>[index('leave_agent_dates').on(t.agentId,t.startDate,t.endDate,t.status),index('leave_approver_status').on(t.approverId,t.status,t.createdAt)]);
export const leaveDocuments = sqliteTable('leave_documents', {
 requestId:text('request_id').notNull().references(()=>leaveRequests.id),version:integer('version').notNull(),kind:text('kind').notNull(),content:text('content').notNull(),
 mime:text('mime').notNull(),digest:text('digest').notNull(),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.requestId,t.version,t.kind]})]);
export const leaveEvents = sqliteTable('leave_events', {
 id:text('id').primaryKey(),requestId:text('request_id').notNull().references(()=>leaveRequests.id),actorId:text('actor_id').notNull().references(()=>users.id),
 action:text('action').notNull(),note:text('note').notNull().default(''),createdAt:text('created_at').notNull(),
},t=>[index('leave_events_request').on(t.requestId,t.createdAt)]);
export const notifications = sqliteTable('notifications', {
 id:text('id').primaryKey(),recipientId:text('recipient_id').notNull().references(()=>users.id),eventKey:text('event_key').notNull(),
 category:text('category').notNull(),title:text('title').notNull(),body:text('body').notNull(),targetType:text('target_type').notNull(),targetId:text('target_id').notNull(),
 createdAt:text('created_at').notNull(),readAt:text('read_at'),
},t=>[uniqueIndex('notifications_recipient_event').on(t.recipientId,t.eventKey),index('notifications_recipient_date').on(t.recipientId,t.createdAt,t.id),index('notifications_unread').on(t.recipientId,t.readAt)]);
