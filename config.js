// config.js
module.exports = {
    // RPC / WSS
    RPC_URL: "https://atlantic.dplabs-internal.com",
    WSS_URL: "wss://atlantic.dplabs-internal.com", // optionnel, pas utilisé par sync.js mais utile plus tard pour listener
  
    // Contracts
    CORE_ADDRESS: "0xE8c2F27822BeD03BD1Fd6C4BcEE5E92cD0D99B02",
    PAYMASTER_ADDRESS: "0x969b078E1b4f08D3BEe7d2A83B9d2af114e84eE4",
  
    // Local private write server
    WRITE_BASE_URL: "http://127.0.0.1:7001",
  
    // Local sqlite file (used ONLY for repair scan)
    DB_PATH: "./trades.db",
  
    // Limits you requested
    MAX_IDS_PER_RPC_CALL: 50,
    MAX_RPC_CONCURRENCY: 20,
  
    // Write batching (your endpoint max 2000)
    MAX_TRADES_PER_WRITE_BATCH: 2000,
  };