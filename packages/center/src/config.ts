export interface CenterConfig {
  wsPort: number;
  httpPort: number;
  dbType: "sqlite" | "postgres";
  dbPath: string;
  postgresUrl: string;
  relayToken: string;
  maxHistory: number;
}

export function loadConfig(): CenterConfig {
  return {
    wsPort: parseInt(process.env.WS_PORT || "9876", 10),
    httpPort: parseInt(process.env.HTTP_PORT || "3000", 10),
    dbType: (process.env.DB_TYPE as "sqlite" | "postgres") || "sqlite",
    dbPath: process.env.DB_PATH || "./flow-a2a-center.db",
    postgresUrl: process.env.DATABASE_URL || "",
    relayToken: process.env.RELAY_TOKEN || "",
    maxHistory: parseInt(process.env.MAX_HISTORY || "200", 10),
  };
}
