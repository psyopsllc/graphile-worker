import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const sqlDir = join(process.cwd(), "../sql");
const sqlFiles = readdirSync(sqlDir);

const sqlModule = sqlFiles.reduce((acc, file) => {
  const sql = readFileSync(join(sqlDir, file), "utf8");
  const varName = "sql_" + file.replace(".sql", "").replace(/-/g, "_");
  return acc + `export const ${varName} = \`${sql}\`;\n`;
}, "");

writeFileSync(join(process.cwd(), "../src/sql/index.ts"), sqlModule);
