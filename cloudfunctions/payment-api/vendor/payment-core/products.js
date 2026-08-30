"use strict";

const PRODUCTS = Object.freeze([
  Object.freeze({
    productId: "pkg_990",
    amountFen: 990,
    grantPoints: 100,
    title: "100 积分"
  }),
  Object.freeze({
    productId: "pkg_2990",
    amountFen: 2990,
    grantPoints: 330,
    title: "330 积分"
  }),
  Object.freeze({
    productId: "pkg_5990",
    amountFen: 5990,
    grantPoints: 688,
    title: "688 积分"
  })
]);

const PRODUCT_BY_ID = new Map(PRODUCTS.map((item) => [item.productId, item]));

function getProduct(productId) {
  const product = PRODUCT_BY_ID.get(String(productId || "").trim());
  return product ? Object.assign({}, product) : null;
}

function publicProducts(enabledProductIds) {
  const enabled = new Set(Array.isArray(enabledProductIds) ? enabledProductIds : []);
  return PRODUCTS
    .filter((item) => enabled.has(item.productId))
    .map((item) => Object.assign({}, item));
}

module.exports = {
  PRODUCTS,
  getProduct,
  publicProducts
};
