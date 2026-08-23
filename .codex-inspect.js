const fs = require("fs");
const lines = fs.readFileSync("cloudfunctions/api/index.js", "utf8").split(/\r?\n/);
for (const [start, end] of [[2525, 2625], [3470, 3605], [3805, 3885]]) {
  console.log(`\n===== ${start}-${end} =====`);
  for (let index = start - 1; index < Math.min(end, lines.length); index += 1) {
    console.log(`${String(index + 1).padStart(5)}: ${lines[index]}`);
  }
}
