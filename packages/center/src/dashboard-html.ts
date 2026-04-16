import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DASHBOARD_HTML = readFileSync(
  join(__dirname, "dashboard.html"),
  "utf-8",
);
