export interface User {
  id: string;
  email: string;
  wallet_type: 'EOA' | 'CIRCLE';
  usdc_account_balance: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  usdc_price: number;
  rating: number;
  review_count: number;
  tags: string[];
  category: string;
  api_endpoint?: string;
  developer_id?: string;
  metadataUri?: string;
  icon?: string;
  destinationType?: 'market_chart' | 'block_explorer';
  network?: string;
}

export interface ExecutionLog {
  id: string;
  agent_id: string;
  agent_name: string;
  timestamp: string;
  status: 'SUCCESS' | 'FAILURE';
  tx_type: 'Deployment' | 'Nanopayment' | 'Listing' | 'Transfer In' | 'Transfer Out';
  cost_usdc: number;
  tx_hash?: string;
}
