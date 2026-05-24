(function () {
  function textOf(node) {
    return (node?.innerText || node?.textContent || "").trim();
  }

  function hasCurrentPlan(text) {
    return text.includes("你当前的套餐") || text.toLowerCase().includes("current plan");
  }

  function findCurrentPlanCard() {
    const candidates = [...document.querySelectorAll("section, article, div")]
      .filter((el) => {
        const text = textOf(el);
        return text.includes("Pro") && hasCurrentPlan(text);
      })
      .sort((a, b) => textOf(a).length - textOf(b).length);
    return candidates[0] || null;
  }

  function luminanceFromRgb(rgb) {
    const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return 255;
    const [, r, g, b] = match.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function isSelectedTier(el) {
    const ariaPressed = el.getAttribute("aria-pressed");
    const ariaSelected = el.getAttribute("aria-selected");
    if (ariaPressed === "true" || ariaSelected === "true") return true;
    if (el.matches("[data-state='checked'], [data-state='active'], [data-selected='true']")) return true;

    const style = getComputedStyle(el);
    return luminanceFromRgb(style.backgroundColor) < 55;
  }

  function detectProTierFromPricing() {
    const card = findCurrentPlanCard();
    if (!card) return null;

    const tierEls = [...card.querySelectorAll("button, [role='button'], [role='tab'], div, span")]
      .filter((el) => /^(5x|20x)$/i.test(textOf(el)));

    const selected = tierEls.find(isSelectedTier);
    const selectedText = textOf(selected || tierEls[0] || "").toLowerCase();
    if (selectedText === "20x") return "pro20";
    if (selectedText === "5x") return "pro5";
    return "pro5";
  }

  async function saveDetectedPlan() {
    if (!location.href.includes("#pricing") && !document.body?.innerText?.includes("选择套餐")) return;
    const plan = detectProTierFromPricing();
    if (!plan) return;
    await chrome.storage.local.set({
      codexPlan: plan,
      codexPlanDetectedAt: Date.now(),
      codexPlanDetectedFrom: "pricing",
    });
  }

  globalThis.detectProTierFromPricing = detectProTierFromPricing;
  saveDetectedPlan();
  setTimeout(saveDetectedPlan, 1000);
})();
