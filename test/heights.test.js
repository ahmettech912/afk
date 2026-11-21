'use strict'
// Blok yüksekliği türetme testi: node test/heights.test.js
const mcData = require('minecraft-data')
const { deriveHeights } = require('../sonar-bypass')

let failures = 0
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg) } else console.log('OK:', msg) }

for (const v of ['1.20.4', '1.21.4', '1.8.8']) {
  const d = mcData(v)
  const H = deriveHeights(d)
  const n = Object.keys(H).length
  check(n > 100, `${v}: ${n} collision block state`)
  const stone = d.blocksByName.stone
  check(H[stone.minStateId] === 1, `${v}: stone height = 1`)
  check(H[d.blocksByName.air.minStateId] === undefined, `${v}: air excluded`)
  if (d.blocksByName.water) check(H[d.blocksByName.water.minStateId] === undefined, `${v}: water excluded`)
  if (d.blocksByName.oak_slab) {
    const slab = d.blocksByName.oak_slab
    // state order: top, top(w), bottom, bottom(w), double, double(w)
    check(H[slab.minStateId] === 1, `${v}: top slab height = 1`)
    check(H[slab.minStateId + 2] === 0.5, `${v}: bottom slab height = 0.5`)
    check(H[slab.minStateId + 4] === 1, `${v}: double slab height = 1`)
  }
  if (d.blocksByName.oak_fence) {
    const fence = d.blocksByName.oak_fence
    let all15 = true
    for (let s = fence.minStateId; s <= fence.maxStateId; s++) if (H[s] !== 1.5) all15 = false
    check(all15, `${v}: oak fence height = 1.5 (all states)`)
  }
}

if (failures) { console.error(failures + ' FAILURES'); process.exit(1) }
console.log('ALL HEIGHT TESTS OK')
