// HypeStack Core Domain Types

export interface User {
  id: string;
  email: string;
  full_name: string;
  national_id_verified: boolean;
  created_at: Date;
}

export interface Product {
  id: string;
  prompter_id: string;
  title: string;
  floor_price: number;
  backer_buyin_threshold: number;
  retail_price: number;
  stock_quantity: number;
  generation_hash?: string;
  created_at: Date;
}

export type CampaignStatus =
  | 'pending'
  | 'active'
  | 'paused_out_of_funds'
  | 'paused_flagged'
  | 'completed';

export interface Campaign {
  id: string;
  product_id: string;
  creator_id: string;
  ad_set_id?: string;
  ad_video_url?: string;
  landing_page_url?: string;
  audience_params?: string;
  hype_score: number;
  is_active: boolean;
  status: CampaignStatus;
  created_at: Date;
}

export interface AdPool {
  id: string;
  campaign_id: string;
  backer_id: string;
  total_allocated_budget: number;
  remaining_budget: number;
  backer_share_percentage: number;
  created_at: Date;
}

export type EscrowStatus = 'holding' | 'released' | 'refunded' | 'voided';

export type DeliveryStatus =
  | 'pending'
  | 'dispatched'
  | 'in_transit'
  | 'delivered'
  | 'failed'
  | 'returned_to_sender';

export interface Order {
  id: string;
  campaign_id: string;
  customer_name: string;
  customer_phone: string;
  shipping_address: string;
  amount_paid: number;
  escrow_status: EscrowStatus;
  tracking_code?: string;
  delivery_status: DeliveryStatus;
  refund_requested: boolean;
  created_at: Date;
}

export type BalanceType =
  | 'available'
  | 'pending_escrow'
  | 'active_ad_float'
  | 'platform_pool';

export type TransactionDirection = 'debit' | 'credit';

export interface LedgerTransaction {
  id: number;
  user_id: string;
  order_id?: string;
  amount: number;
  balance_type: BalanceType;
  direction: TransactionDirection;
  description: string;
  created_at: Date;
}

// Revenue split calculation result
export interface RevenueSplit {
  gross_revenue: number;
  floor_cost: number;
  backer_buyin_threshold: number;
  upper_delta: number;
  prompter_delta: number;
  platform_split: number;
  prompter_cut: number;
  backer_split: number;
  ad_cost_per_purchase: number;
}

// Vault balance summary per user
export interface VaultBalance {
  user_id: string;
  available: number;
  pending_escrow: number;
  active_ad_float: number;
}

// Arena feed item
export interface ArenaItem {
  campaign_id: string;
  product_title: string;
  ad_video_url?: string;
  landing_page_url?: string;
  hype_score: number;
  squad_size: number;
  min_stack_amount: number;
}

// Delivery webhook payload from courier (e.g. Viettel Post)
export interface DeliveryWebhookPayload {
  tracking_code: string;
  delivery_status: DeliveryStatus;
  timestamp: string;
  courier_note?: string;
}
