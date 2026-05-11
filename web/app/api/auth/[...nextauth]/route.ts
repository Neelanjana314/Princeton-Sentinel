import NextAuth from "next-auth";
import { getAuthOptions } from "@/app/lib/auth";
export const dynamic = "force-dynamic";

export const GET = async (req: any, res: any) => NextAuth(await getAuthOptions())(req, res);
export const POST = async (req: any, res: any) => NextAuth(await getAuthOptions())(req, res);
