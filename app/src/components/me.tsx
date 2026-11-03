"use client";
import { createContext, useContext } from "react";

export interface Me { companyId: string; user: { username: string; displayName: string; isOwner: boolean }; permissions: "ALL" | string[] }
export const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const can = (me: Me, perm: string) => me.permissions === "ALL" || me.permissions.includes(perm);
