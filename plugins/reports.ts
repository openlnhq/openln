import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, paymentEventsTable, transactionsTable } from "../core/db/index.js";
const json=(r:ServerResponse,s:number,b:unknown)=>{r.writeHead(s,{"content-type":"application/json"});r.end(JSON.stringify(b));return true;};
export async function handleReportsRoute(req:IncomingMessage,res:ServerResponse,u:URL,account:{id:string}|undefined):Promise<boolean>{
 if(!u.pathname.startsWith("/api/reports/")) return false;
 if(!account)return json(res,401,{error:"Authentication required"});
 if(req.method!=="GET")return json(res,405,{error:"Method not allowed"});
 const from=u.searchParams.get("from")?new Date(u.searchParams.get("from")!):undefined;
 const to=u.searchParams.get("to")?new Date(u.searchParams.get("to")!):undefined;
 const filters=[eq(transactionsTable.accountId,account.id),...(from?[sql`${transactionsTable.createdAt} >= ${from}`]:[]),...(to?[sql`${transactionsTable.createdAt} <= ${to}`]:[])];
 if(u.pathname==="/api/reports/summary"){
  const [row]=await db.select({count:sql<number>`count(*)`,totalIn:sql<number>`coalesce(sum(case when ${transactionsTable.direction}='in' and ${transactionsTable.status}='completed' then ${transactionsTable.amountSats} else 0 end),0)`,totalOut:sql<number>`coalesce(sum(case when ${transactionsTable.direction}='out' and ${transactionsTable.status}='completed' then ${transactionsTable.amountSats} else 0 end),0)`,fees:sql<number>`coalesce(sum(case when ${transactionsTable.type}='fee' and ${transactionsTable.status}='completed' then ${transactionsTable.amountSats} else 0 end),0)`}).from(transactionsTable).where(and(...filters));
  const [events]=await db.select({count:sql<number>`count(*)`}).from(paymentEventsTable).where(eq(paymentEventsTable.accountId,account.id));
  return json(res,200,{transactions:Number(row?.count??0),totalInboundSats:Number(row?.totalIn??0),totalOutboundSats:Number(row?.totalOut??0),feeRevenueSats:Number(row?.fees??0),paymentEvents:Number(events?.count??0),from:from?.toISOString()??null,to:to?.toISOString()??null});
 }
 if(u.pathname==="/api/reports/transactions"){
  const limit=Math.min(100,Math.max(1,Number(u.searchParams.get("limit")??50))); const rows=await db.select().from(transactionsTable).where(and(...filters)).orderBy(desc(transactionsTable.createdAt)).limit(limit); return json(res,200,{transactions:rows});
 }
 return json(res,404,{error:"Not found"});
}
