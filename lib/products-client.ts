'use client';

import {
  CURRENT_PRODUCT_COOKIE,
  DEFAULT_PRODUCT_COOKIE,
  PRODUCTS,
  productForPath,
  safeProductPath,
  type Product,
} from '@/lib/products';

const ONE_YEAR = 60 * 60 * 24 * 365;
const lastPathKey = (product: Product) => `mailflow.lastPath.${product}`;

function setCookie(name: string, value: string | null) {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = value === null
    ? `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
    : `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
}

/**
 * Called on every navigation: remembers the last page per product (so the
 * switcher returns you there) and which product you're in (so shared pages
 * like Settings keep that product's sidebar, even after a reload).
 */
export function rememberVisit(pathnameWithSearch: string) {
  const product = productForPath(pathnameWithSearch);
  if (!product) return;
  try {
    localStorage.setItem(lastPathKey(product), pathnameWithSearch);
  } catch {
    // storage unavailable (private mode): the switcher falls back to the product home
  }
  setCookie(CURRENT_PRODUCT_COOKIE, product);
}

export function lastPathFor(product: Product): string {
  try {
    return safeProductPath(product, localStorage.getItem(lastPathKey(product)));
  } catch {
    return PRODUCTS[product].home;
  }
}

/** The product opened straight after sign-in; null = ask every time. */
export function setDefaultProduct(product: Product | null) {
  setCookie(DEFAULT_PRODUCT_COOKIE, product);
}

export function markCurrentProduct(product: Product) {
  setCookie(CURRENT_PRODUCT_COOKIE, product);
}
