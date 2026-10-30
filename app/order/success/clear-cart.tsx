"use client";
import { useEffect } from "react";

export default function ClearCart() {
  useEffect(() => {
    try { localStorage.removeItem("empanadas-cart-v1"); } catch { /* ignore */ }
  }, []);
  return null;
}
