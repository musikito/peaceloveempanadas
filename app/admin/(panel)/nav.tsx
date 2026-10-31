"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "./actions";

const links = [
  { href: "/admin", label: "Sales" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/products", label: "Menu" },
  { href: "/admin/settings", label: "Settings" },
];

export default function Nav({ shopName, logo }: { shopName: string; logo: string | null }) {
  const path = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin">
      {logo ? <img className="admin-logo" src={logo} alt={shopName} /> : <strong>{shopName}</strong>}
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>
      ))}
      <Link href="/" target="_blank">View shop</Link>
      <form action={signOut}><button className="linklike" type="submit">Sign out</button></form>
    </nav>
  );
}
