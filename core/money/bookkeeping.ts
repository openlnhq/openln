import type { TransactionClass, TransactionOrigin } from "../db/schema/transactions.js";

// Bitcoin is money. Every movement gets a bookkeeping class at the moment it is
// written, from the surface that produced it. The account holder can correct
// any row later (class_source = user); the system never overwrites a user class.
//
//   RIC / web POS / LN address receive  -> sale      (revenue at the fiat value of that moment)
//   wallet Receive screen               -> top_up    (owner funding the wallet, not income)
//   RIC send / send to card             -> transfer_out (owner moving own funds, not an expense)
//   card tap / wallet pay               -> spend
//   openLN handle to handle             -> sale in / spend out (owner can reclassify)
export function classifyMovement(origin: TransactionOrigin | string | null | undefined, direction: "in" | "out"): TransactionClass {
  switch (origin) {
    case "ric":
    case "web_pos":
    case "ln_address":
    case "shop":
      return direction === "in" ? "sale" : "transfer_out";
    case "wallet":
      return direction === "in" ? "top_up" : "spend";
    case "card":
      return direction === "in" ? "sale" : "spend";
    case "internal":
      return direction === "in" ? "sale" : "spend";
    default:
      return "other";
  }
}

export const CLASS_LABEL: Record<TransactionClass, string> = {
  sale: "Sale",
  top_up: "Top-up",
  transfer_out: "Transfer to own wallet",
  spend: "Spend",
  refund: "Refund",
  fee: "Fee",
  other: "Needs review",
};

export const ORIGIN_LABEL: Record<string, string> = {
  ric: "RIC terminal",
  web_pos: "Web POS",
  ln_address: "Lightning address",
  wallet: "Wallet",
  card: "Card",
  internal: "openLN user",
  shop: "Shop",
};
