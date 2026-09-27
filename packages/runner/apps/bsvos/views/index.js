// The view registry, in its own module so it can be tested without a DOM.
//
// This exists because of a real bug: app.js assembled VIEWS inline and one
// entry lost its spread operator, so the whole Twetch array was inserted as a
// single view with no id — the nav rendered an empty row and five views
// vanished. Every test imported the view modules directly and rebuilt its own
// list, so nothing covered the one line that actually wires them together.
//
// Keeping the assembly here means the render tests import the same array the
// app runs, so a missing spread fails the suite instead of the UI.
"use strict";

import walletViews from "./wallet.js";
import moneyViews from "./money.js";
import socialViews from "./social.js";
import appViews from "./apps.js";
import workViews from "./work.js";
import twetchViews from "./twetch.js";
import { inscribe } from "./inscribe.js";
import { setup } from "./setup.js";

export const VIEWS = [
  // setup first: it is where a new machine starts, and most other views
  // dead-end until a wallet exists.
  setup,
  ...walletViews,
  ...moneyViews,
  inscribe,
  ...socialViews,
  ...twetchViews,
  ...appViews,
  ...workViews,
];

export const GROUP_ORDER = ["Wallet", "Money", "Twetch", "Identity", "Apps", "Work"];

export const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
