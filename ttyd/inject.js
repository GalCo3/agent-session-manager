// Inject ttyd/shim.html into ttyd's stock index, before </body>.
// Usage: node inject.js <stock.html> <shim.html> <out.html>
const fs = require("fs");
const [stock, shim, out] = process.argv.slice(2);
if (!stock || !shim || !out) {
  console.error("usage: node inject.js <stock.html> <shim.html> <out.html>");
  process.exit(1);
}
const html = fs.readFileSync(stock, "utf8");
const inject = fs.readFileSync(shim, "utf8");
const idx = html.lastIndexOf("</body>");
if (idx === -1) { console.error("no </body> in stock ttyd index"); process.exit(1); }
fs.writeFileSync(out, html.slice(0, idx) + "\n" + inject + "\n" + html.slice(idx));
console.log("wrote", out, "(" + fs.statSync(out).size + " bytes)");
