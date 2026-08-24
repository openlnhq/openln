// @ts-nocheck
/** Shop settlement is a plugin boundary; core monitor has no shop dependency. */
export async function autoSettleShopOrders(_accountId: string): Promise<void> {}
export async function directSettleShopOrder(_orderId: string, _accountId: string): Promise<void> {}
