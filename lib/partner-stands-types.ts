export type StandTiming = 'earlier' | 'same-day' | 'later' | 'unknown';
export type PartnerStand = {
  orderId: string;
  reference: string;
  date: string;
  lineId: string;
  code: string;
  type: string;
  quantity: number;
  timing: StandTiming;
};
export type PartnerStandsReport = {
  firstBilling: string | null;
  billingThrough: string | null;
  availableFrom: string | null;
  stands: PartnerStand[];
};
