const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(
  path.join(__dirname, "../src/pages/wallets.js"),
  "utf8"
);

test("wallets page mounts a toolbar above the list with search, sort, hop range, and reset", () => {
  const toolbarIndex = page.indexOf('component="form"');
  const listIndex = page.indexOf("visibleWallets.map");

  assert.notEqual(toolbarIndex, -1);
  assert.ok(toolbarIndex < listIndex);
  assert.match(page, /Address prefix/);
  assert.match(page, /Case-sensitive address or prefix/);
  assert.match(page, /label="Min hops"/);
  assert.match(page, /label="Max hops"/);
  assert.match(page, />\s*Reset\s*</);
  assert.match(page, />\s*Search\s*</);
  assert.match(page, /SORT_OPTIONS\.map/);
});

test("wallets mobile toolbar keeps min/max hops side-by-side with short labels and a scope caption", () => {
  const minIndex = page.indexOf('label="Min hops"');
  const maxIndex = page.indexOf('label="Max hops"');
  const hopsRowStart = page.lastIndexOf("<Stack", minIndex);
  const hopsRowEnd = page.indexOf("</Stack>", maxIndex);
  const hopsRow = page.slice(hopsRowStart, hopsRowEnd);

  assert.notEqual(minIndex, -1);
  assert.notEqual(maxIndex, -1);
  assert.ok(minIndex < maxIndex);
  assert.match(hopsRow, /direction=["']row["']/);
  assert.match(hopsRow, /flex:\s*1/);
  assert.match(hopsRow, /minWidth:\s*0/);
  assert.doesNotMatch(hopsRow, /label=["']Sort["']/);
  assert.doesNotMatch(page, /Min hops \(loaded results\)/);
  assert.doesNotMatch(page, /Max hops \(loaded results\)/);
});

test("wallets mobile toolbar puts sort on its own row and Reset/Search on one xs row", () => {
  const sortIndex = page.indexOf('label="Sort"');
  const sortRowStart = page.lastIndexOf("<Stack", sortIndex);
  const sortRowEnd = page.indexOf("</Stack>", sortIndex);
  const sortRow = page.slice(sortRowStart, sortRowEnd);
  const resetClick = page.indexOf("onClick={handleReset}");
  const actionsRowStart = page.lastIndexOf("<Stack", resetClick);
  const actionsRowEnd = page.indexOf("</Stack>", resetClick);
  const actionsRow = page.slice(actionsRowStart, actionsRowEnd);

  assert.doesNotMatch(sortRow, /label=["']Min hops["']/);
  assert.doesNotMatch(sortRow, /label=["']Max hops["']/);
  assert.match(actionsRow, /direction=\{\{\s*xs:\s*["']row["']/);
  assert.match(actionsRow, /flex:\s*1/);
  assert.match(actionsRow, /minWidth:\s*0/);
  assert.match(actionsRow, /minHeight:\s*44/);
});

test("wallets page does not pass unsupported MUI Stack alignItems or justifyContent props", () => {
  assert.doesNotMatch(page, /<Stack[\s\S]*?\salignItems=/);
  assert.doesNotMatch(page, /<Stack[\s\S]*?\sjustifyContent=/);
  assert.match(page, /sx=\{\{[\s\S]*alignItems:/);
  assert.match(page, /sx=\{\{[\s\S]*justifyContent:/);
});

test("wallets page uses global-scope copy, match counts, and distinct empty states", () => {
  assert.match(page, /getScopeCopy\(/);
  assert.match(page, /getMatchSummary\(/);
  assert.match(page, /getEmptyState\(/);
  assert.match(page, /data-empty-kind=\{emptyState\.kind\}/);
  assert.match(page, /shouldShowLoadMore\(/);
  assert.match(page, /loadMoreLabel/);
  assert.match(page, /getLoadMoreLabel/);
  assert.match(page, /formatWalletsUpdatedAt/);
  assert.match(page, /getVisibleWallets/);
  assert.match(page, /index-building/);
  assert.doesNotMatch(page, /applyLoadedView/);
  assert.doesNotMatch(page, /loaded wallets only/);
  assert.doesNotMatch(page, /Minimum hops on loaded results/);
  assert.doesNotMatch(page, /Maximum hops on loaded results/);
});

test("wallets page uses cards on narrow screens and a wrapping table on desktop", () => {
  assert.match(page, /display: \{ xs: "flex", md: "none" \}/);
  assert.match(page, /display: \{ xs: "none", md: "block" \}/);
  assert.match(page, /wordBreak: "break-all"/);
  assert.match(page, /overflowWrap: "anywhere"/);
  assert.match(page, /minHeight: 44/);
  assert.match(page, /Not available/);
  assert.doesNotMatch(page, /inputProps=/);
  assert.match(page, /slotProps=\{\{/);
  assert.match(page, /htmlInput:/);
});

test("wallets page wires abortable search and load-more through the session loader", () => {
  assert.match(page, /createWalletsLoader/);
  assert.match(page, /loader\.abort\(\)/);
  assert.match(page, /type: "submit-search"/);
  assert.match(page, /append: true/);
  assert.match(page, /type: "reset"/);
  assert.match(page, /type: "set-sort"/);
  assert.match(page, /type: "refresh-snapshot"/);
  assert.match(page, /sort: session\.sort/);
  assert.match(page, /minHops: session\.minHops/);
  assert.match(page, /maxHops: session\.maxHops/);
  assert.match(page, /createWalletsRefreshScheduler/);
  assert.match(page, /document\.visibilityState/);
});
