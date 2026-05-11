import NextAuth from "next-auth";
import { getAuthOptions } from "@/app/lib/auth";
export const dynamic = "force-dynamic";

export const GET = (req: any, res: any) => NextAuth(getAuthOptions())(req, res);
export const POST = (req: any, res: any) => NextAuth(getAuthOptions())(req, res);
