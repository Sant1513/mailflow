'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PRODUCTS, type Product } from '@/lib/products';
import { lastPathFor, markCurrentProduct, setDefaultProduct } from '@/lib/products-client';
import { ProductIcon } from '@/components/nav/ProductSwitcher';

const FEATURES: Record<Product, string[]> = {
  mail: ['Campaigns with approvals', 'Inbox and replies', 'Contacts and data', 'Automations and reports'],
  sign: ['Send a document for signature', 'Bulk send from a CSV', 'Multiple signers and signature placement', 'Templates and tracking'],
};

export function ProductChooser({ savedDefault }: { savedDefault: Product | null }) {
  const router = useRouter();
  const [remember, setRemember] = useState(savedDefault !== null);
  const [going, setGoing] = useState<Product | null>(null);

  function open(product: Product) {
    setGoing(product);
    setDefaultProduct(remember ? product : null);
    markCurrentProduct(product);
    router.push(lastPathFor(product));
  }

  return (
    <>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {(Object.keys(PRODUCTS) as Product[]).map((product) => {
          const p = PRODUCTS[product];
          return (
            <button
              key={product}
              type="button"
              onClick={() => open(product)}
              disabled={going !== null}
              className="panel group flex flex-col p-6 text-left transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-70"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <ProductIcon product={product} className="h-6 w-6" />
                </span>
                <div>
                  <div className="font-heading text-xl font-bold text-foreground">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.tagline}</div>
                </div>
                {savedDefault === product && <span className="badge ml-auto text-[10px]">Your start product</span>}
              </div>
              <ul className="mt-5 space-y-1.5 text-sm text-muted-foreground">
                {FEATURES[product].map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {f}
                  </li>
                ))}
              </ul>
              <span className="mt-6 text-sm font-semibold text-primary">
                {going === product ? 'Opening…' : `Open ${p.name} →`}
              </span>
            </button>
          );
        })}
      </div>

      <label className="mt-6 inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => {
            setRemember(e.target.checked);
            if (!e.target.checked) setDefaultProduct(null);
          }}
          className="h-4 w-4 accent-primary"
        />
        Remember my choice and skip this screen next time
      </label>
    </>
  );
}
