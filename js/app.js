import { withAffiliateTag } from "./affiliate.js";
import { beehiivSignupUrl } from "./signup.js";
import { createSharedDeadDealStore } from "./dead-deals.js";
import {
  categoriesIn,
  dayHeading,
  dealHref,
  dealsFromPayload,
  filterDeals,
  formatMoney,
  groupDeals,
  isExpired,
  longDate,
  shortDate,
  todayISO,
  visibleDeals,
} from "./deals.js";

const state = {
  deals: [],
  category: "All",
  query: "",
  today: todayISO(),
  deadIds: new Set(),
  verifiedIds: new Set(),
};

const store = createSharedDeadDealStore();
const dealsRoot = document.querySelector("#deals");
const filtersRoot = document.querySelector("#filters");
const resultCount = document.querySelector("#result-count");
const copyStatus = document.querySelector("#copy-status");
let copyTimer = 0;

for (const link of document.querySelectorAll("[data-affiliate]")) {
  link.href = withAffiliateTag(link.getAttribute("href"));
}

document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "long",
  month: "long",
  day: "numeric",
}).format(new Date());

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
});

const newsletterForm = document.querySelector("#newsletter-form");
newsletterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = newsletterForm.querySelector("#newsletter-email");
  input.value = input.value.trim();
  if (!input.value || !input.checkValidity()) {
    input.reportValidity();
    return;
  }
  let destination;
  try {
    destination = beehiivSignupUrl(input.value);
  } catch {
    input.setCustomValidity("Enter a valid email address");
    input.reportValidity();
    input.setCustomValidity("");
    return;
  }
  window.location.assign(destination);
});

document.querySelector("#deal-search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

filtersRoot.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.category = chip.dataset.category;
  for (const button of filtersRoot.querySelectorAll(".chip")) {
    button.setAttribute("aria-pressed", button === chip ? "true" : "false");
  }
  render();
});

dealsRoot.addEventListener("click", async (event) => {
  const copyButton = event.target.closest(".copy-btn");
  if (copyButton) {
    const code = copyButton.dataset.code;
    const copied = await copyText(code);
    if (copied) showCopied(copyButton, code);
    else copyStatus.textContent = `Could not copy ${code}. Select the code and copy it.`;
    return;
  }

  const reportButton = event.target.closest(".report-btn");
  if (!reportButton || reportButton.disabled) return;
  const card = reportButton.closest(".card");
  const id = card.dataset.dealId;
  const marked = card.classList.contains("is-dead");
  if (state.verifiedIds.has(id)) return;
  reportButton.disabled = true;
  try {
    if (marked) {
      const still = await store.retract(id);
      if (still?.verified) {
        state.verifiedIds.add(id);
        state.deadIds.add(id);
        hideVerified(id);
      } else {
        state.deadIds.delete(id);
        setDead(card, false);
      }
    } else {
      const record = await store.report(id);
      state.deadIds.add(id);
      if (record?.verified) {
        state.verifiedIds.add(id);
        hideVerified(id);
      } else {
        setDead(card, true);
      }
    }
  } finally {
    if (!state.verifiedIds.has(id)) reportButton.disabled = false;
  }
});

init();

async function init() {
  try {
    const response = await fetch(new URL("../data/deals.json", import.meta.url), { cache: "no-cache" });
    if (!response.ok) throw new Error(`Could not load deals (${response.status})`);
    state.deals = visibleDeals(dealsFromPayload(await response.json()), state.today);
    applyReports(await store.list());
    state.deals = state.deals.filter((deal) => !state.verifiedIds.has(deal.id));
    renderChips(categoriesIn(state.deals));
    render();
  } catch (error) {
    dealsRoot.replaceChildren(message(error.message || "Deals could not be loaded."));
  }
}

function renderChips(categories) {
  filtersRoot.replaceChildren();
  for (const category of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.category = category;
    button.textContent = category;
    button.setAttribute("aria-pressed", category === state.category ? "true" : "false");
    filtersRoot.append(button);
  }
}

function render() {
  const filtered = filterDeals(state.deals, state);
  const groups = groupDeals(filtered);
  const count = filtered.length;
  resultCount.textContent = count === 0 ? "No matching deals" : `${count} deal${count === 1 ? "" : "s"}`;

  if (count === 0) {
    const text = state.deals.length === 0
      ? "No deals yet. Add some in data/deals.json."
      : "No deals match that search.";
    dealsRoot.replaceChildren(message(text, "empty"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    fragment.append(renderGroup(group));
  }
  dealsRoot.replaceChildren(fragment);
}

function renderGroup(group) {
  const section = document.createElement("section");
  section.className = "day";
  const heading = document.createElement("h2");
  const label = dayHeading(group.date, state.today);
  heading.textContent = label;
  const meta = document.createElement("p");
  meta.className = "day-meta";
  const countLabel = `${group.deals.length} deal${group.deals.length === 1 ? "" : "s"}`;
  meta.textContent = label === "Today" || label === "Yesterday"
    ? `${longDate(group.date)} · ${countLabel}`
    : countLabel;
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const deal of group.deals) grid.append(renderCard(deal));
  section.append(heading, meta, grid);
  return section;
}

function renderCard(deal) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.dealId = deal.id;
  if (deal.sample) card.dataset.sample = "true";

  const media = document.createElement("div");
  media.className = "card-media";
  const image = document.createElement("img");
  image.src = deal.image;
  image.alt = deal.sample ? `${deal.title}, example placeholder` : deal.title;
  image.width = 800;
  image.height = 500;
  image.decoding = "async";
  media.append(image);

  if (deal.percentOff > 0) {
    const off = document.createElement("span");
    off.className = "badge-off";
    off.textContent = `${deal.percentOff}% off`;
    media.append(off);
  }
  if (deal.sample) {
    const sample = document.createElement("span");
    sample.className = "badge-sample";
    sample.textContent = "Example";
    media.append(sample);
  }
  const deadFlag = document.createElement("span");
  deadFlag.className = "dead-flag";
  deadFlag.textContent = "Dead";
  deadFlag.setAttribute("aria-hidden", "true");
  media.append(deadFlag);

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("h3");
  title.className = "title";
  title.textContent = deal.title;

  const category = document.createElement("p");
  category.className = "category";
  category.textContent = deal.category;

  const price = document.createElement("p");
  price.className = "price";
  const now = document.createElement("span");
  now.className = "price-now";
  now.append(sr("Current price "), document.createTextNode(formatMoney(deal.price)));
  price.append(now);
  if (typeof deal.originalPrice === "number") {
    const was = document.createElement("s");
    was.className = "price-was";
    was.append(sr("Original price "), document.createTextNode(formatMoney(deal.originalPrice)));
    price.append(was);
  }

  body.append(category, title, price);

  if (deal.promoCode) {
    const row = document.createElement("div");
    row.className = "code-row";
    const code = document.createElement("code");
    code.textContent = deal.promoCode;
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "copy-btn";
    copyButton.dataset.code = deal.promoCode;
    copyButton.setAttribute("aria-label", `Copy promo code ${deal.promoCode}`);
    const copyText = document.createElement("span");
    copyText.className = "copy-text";
    copyText.textContent = "Copy";
    copyButton.append(copyText);
    row.append(code, copyButton);
    body.append(row);
  }

  if (deal.expires) {
    const expiry = document.createElement("p");
    expiry.className = "expiry";
    if (isExpired(deal, state.today)) {
      expiry.classList.add("is-ended");
      expiry.textContent = `Ended ${shortDate(deal.expires)}`;
    } else {
      expiry.textContent = `Ends ${shortDate(deal.expires)}`;
    }
    body.append(expiry);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const view = document.createElement("a");
  view.className = "btn btn-primary";
  view.href = dealHref(deal);
  view.target = "_blank";
  view.rel = "noopener noreferrer sponsored";
  view.textContent = "View on Amazon";
  const report = document.createElement("button");
  report.type = "button";
  report.className = "btn btn-ghost report-btn";
  report.textContent = "Report dead deal";
  report.setAttribute("aria-pressed", "false");
  const note = document.createElement("p");
  note.className = "local-note";
  note.textContent = "Marked dead on this browser.";
  note.hidden = true;
  actions.append(view, report, note);
  body.append(actions);
  card.append(media, body);

  if (state.deadIds.has(deal.id)) setDead(card, true, { verified: state.verifiedIds.has(deal.id) });
  return card;
}

function applyReports(reports) {
  state.deadIds = new Set(reports.map((report) => report.id));
  state.verifiedIds = new Set(reports.filter((report) => report.verified).map((report) => report.id));
}

function hideVerified(id) {
  state.deals = state.deals.filter((deal) => deal.id !== id);
  const categories = categoriesIn(state.deals);
  if (!categories.includes(state.category)) state.category = "All";
  renderChips(categories);
  render();
}

function setDead(card, dead, { verified = false } = {}) {
  const siteWide = Boolean(dead && verified);
  card.classList.toggle("is-dead", dead);
  card.classList.toggle("is-verified", siteWide);
  const flag = card.querySelector(".dead-flag");
  flag.setAttribute("aria-hidden", dead ? "false" : "true");
  const button = card.querySelector(".report-btn");
  button.disabled = siteWide;
  button.textContent = siteWide ? "Verified dead" : dead ? "Undo report" : "Report dead deal";
  button.setAttribute("aria-pressed", dead ? "true" : "false");
  const note = card.querySelector(".local-note");
  note.hidden = !dead;
  note.textContent = siteWide
    ? "Checked against Amazon. Marked dead for everyone."
    : "Marked dead on this browser.";
}

function showCopied(button, code) {
  for (const other of dealsRoot.querySelectorAll(".copy-btn.is-copied")) {
    other.classList.remove("is-copied");
    other.querySelector(".copy-text").textContent = "Copy";
  }
  button.classList.add("is-copied");
  button.querySelector(".copy-text").textContent = "Copied";
  button.setAttribute("aria-label", `Copied promo code ${code}`);
  copyStatus.textContent = `Copied ${code}`;
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    button.classList.remove("is-copied");
    const label = button.querySelector(".copy-text");
    if (label) label.textContent = "Copy";
    button.setAttribute("aria-label", `Copy promo code ${code}`);
  }, 4000);
}

function legacyCopy(code) {
  try {
    const field = document.createElement("textarea");
    field.value = code;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "0";
    field.style.left = "0";
    field.style.opacity = "0";
    document.body.append(field);
    field.focus();
    field.select();
    field.setSelectionRange(0, code.length);
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyText(code) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      return true;
    } catch {
      return legacyCopy(code);
    }
  }
  return legacyCopy(code);
}

function sr(text) {
  const span = document.createElement("span");
  span.className = "sr-only";
  span.textContent = text;
  return span;
}

function message(text, className = "empty") {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  return paragraph;
}
