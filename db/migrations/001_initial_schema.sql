-- HypeStack Database Schema
-- Migration: 001_initial_schema

-- Users Table
-- Tracks individual profiles with KYC verification status
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    national_id_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products Table
-- Registers physical inventory linked to a prompter
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title VARCHAR(500) NOT NULL,
    floor_price NUMERIC(18, 2) NOT NULL,
    backer_buyin_threshold NUMERIC(18, 2) NOT NULL,
    retail_price NUMERIC(18, 2) NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    generation_hash VARCHAR(256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_floor_price_positive CHECK (floor_price > 0),
    CONSTRAINT chk_buyin_lte_retail CHECK (backer_buyin_threshold <= retail_price),
    CONSTRAINT chk_floor_lte_buyin CHECK (floor_price <= backer_buyin_threshold),
    CONSTRAINT chk_stock_non_negative CHECK (stock_quantity >= 0)
);

-- Campaigns Table
-- Manages active ad assets linked to a product and creator
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    ad_set_id VARCHAR(256),
    ad_video_url TEXT,
    landing_page_url TEXT,
    audience_params TEXT,
    hype_score NUMERIC(10, 4) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(64) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_hype_score_non_negative CHECK (hype_score >= 0),
    CONSTRAINT chk_status_values CHECK (status IN ('pending', 'active', 'paused_out_of_funds', 'paused_flagged', 'completed'))
);

-- Ad Pools Table
-- Governs decentralized capital controls (backer funding per campaign)
CREATE TABLE IF NOT EXISTS ad_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    backer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    total_allocated_budget NUMERIC(18, 2) NOT NULL,
    remaining_budget NUMERIC(18, 2) NOT NULL,
    backer_share_percentage NUMERIC(7, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_remaining_budget_non_negative CHECK (remaining_budget >= 0),
    CONSTRAINT chk_allocated_positive CHECK (total_allocated_budget > 0),
    CONSTRAINT chk_share_percentage_range CHECK (backer_share_percentage >= 0 AND backer_share_percentage <= 100)
);

-- Orders Table
-- Handles upfront customer transactions (100% prepaid)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    customer_name VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    shipping_address TEXT NOT NULL,
    amount_paid NUMERIC(18, 2) NOT NULL,
    escrow_status VARCHAR(64) NOT NULL DEFAULT 'holding',
    tracking_code VARCHAR(256),
    delivery_status VARCHAR(64) NOT NULL DEFAULT 'pending',
    refund_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_amount_paid_positive CHECK (amount_paid > 0),
    CONSTRAINT chk_escrow_status_values CHECK (escrow_status IN ('holding', 'released', 'refunded', 'voided')),
    CONSTRAINT chk_delivery_status_values CHECK (delivery_status IN ('pending', 'dispatched', 'in_transit', 'delivered', 'failed', 'returned_to_sender'))
);

-- Ledger Transactions Table
-- Master double-entry accounting ledger
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    amount NUMERIC(18, 2) NOT NULL,
    balance_type VARCHAR(64) NOT NULL,
    direction VARCHAR(16) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_amount_non_zero CHECK (amount != 0),
    CONSTRAINT chk_direction_values CHECK (direction IN ('debit', 'credit')),
    CONSTRAINT chk_balance_type_values CHECK (balance_type IN ('available', 'pending_escrow', 'active_ad_float', 'platform_pool'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_prompter ON products(prompter_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_product ON campaigns(product_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_creator ON campaigns(creator_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_active ON campaigns(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ad_pools_campaign ON ad_pools(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_pools_backer ON ad_pools(backer_id);
CREATE INDEX IF NOT EXISTS idx_orders_campaign ON orders(campaign_id);
CREATE INDEX IF NOT EXISTS idx_orders_escrow_status ON orders(escrow_status);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_transactions(created_at);
