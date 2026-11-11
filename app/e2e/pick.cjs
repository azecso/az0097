// The search-and-choose field (combobox): type, then press the matching option. Never a <select>.
exports.pick = async (p, sel, text, typed) => {
  const el = typeof sel === "string" ? p.locator(sel) : sel;
  await el.click(); await el.fill(typed ?? text);
  await p.locator("[role=option]").filter({ hasText: text }).first().click();
};
