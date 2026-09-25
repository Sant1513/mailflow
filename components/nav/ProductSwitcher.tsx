'use client';

import { useRouter } from 'next/navigation';
import { PRODUCTS, type Product } from '@/lib/products';
import { lastPathFor, markCurrentProduct } from '@/lib/products-client';

export function ProductIcon({ product, className = 'h-4 w-4' }: { product: Product; className?: string }) {
  if (product === 'mail') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" />
      <path d="M3 22h18" />
    </svg>
  );
}

/**
 * One-click switch between Mail and Sign. Switching takes you back to the
 * last page you used in the other product, or its home page.
 */
export function ProductSwitcher({ current, compact = false }: { current: Product; compact?: boolean }) {
  const router = useRouter();

  function go(product: Product) {
    if (product === current) {
      router.push(PRODUCTS[product].home);
      return;
    }
    markCurrentProduct(product);
    router.push(lastPathFor(product));
  }

  return (
    <div
      role="tablist"
      aria-label="Product"
      className={`grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1 ${compact ? 'text-xs' : 'text-sm'}`}
    >
      {(Object.keys(PRODUCTS) as Product[]).map((product) => {
        const active = product === current;
        return (
          <button
            key={product}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => go(product)}
            title={active ? `${PRODUCTS[product].name} home` : `Switch to ${PRODUCTS[product].name}`}
            className={`flex items-center justify-center gap-1.5 rounded-md font-medium transition ${compact ? 'px-2 py-1' : 'px-2 py-1.5'} ${
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
            }`}
          >
            <ProductIcon product={product} className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            {PRODUCTS[product].name}
          </button>
        );
      })}
    </div>
  );
}
