"use client";
import { useState } from "react";
import { createInstructorScheduleBlockAction, updateInstructorScheduleBlockAction, deleteInstructorScheduleBlockAction } from "./actions";

type Option={id:string;name:string};
export default function InstructorScheduleBlockForm({ instructors, rooms, initialDate="", initialStartTime="", initialEndTime="", initialInstructorId="", block }: { instructors:Option[]; rooms:Option[]; initialDate?:string; initialStartTime?:string; initialEndTime?:string; initialInstructorId?:string; block?:{id:string;instructor_id:string;room_id:string|null;reason:string;title:string;notes:string|null;startsAtLocal:string;endsAtLocal:string} }) {
 const [recurring,setRecurring]=useState(false);
 const action=block?updateInstructorScheduleBlockAction:createInstructorScheduleBlockAction;
 return <form action={action} className="space-y-5 rounded-[28px] border border-violet-200 bg-white p-6 shadow-sm">
  {block?<input type="hidden" name="blockId" value={block.id}/>:null}
  <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Schedule protection</p><h1 className="mt-2 text-2xl font-semibold text-slate-950">{block?"Edit blocked time":"Block instructor time"}</h1><p className="mt-2 text-sm text-slate-600">Reserve lunch, practice, travel, meetings, or personal time without creating a client appointment.</p></div>
  <div className="grid gap-4 sm:grid-cols-2">
   <label className="text-sm font-medium">Instructor<select name="instructorId" required defaultValue={block?.instructor_id||initialInstructorId||""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"><option value="">Choose instructor</option>{instructors.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
   <label className="text-sm font-medium">Reason<select name="reason" defaultValue={block?.reason||"lunch"} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"><option value="lunch">Lunch</option><option value="practice">Practice</option><option value="meeting">Meeting</option><option value="travel">Travel</option><option value="personal">Personal</option><option value="other">Other</option></select></label>
   <label className="text-sm font-medium sm:col-span-2">Title<input name="title" required defaultValue={block?.title||""} placeholder="Lunch break" className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"/></label>
   <label className="text-sm font-medium">Starts<input name="startsAt" type="datetime-local" required defaultValue={block?.startsAtLocal||(initialDate?`${initialDate}T${initialStartTime||"12:00"}`:"")} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"/></label>
   <label className="text-sm font-medium">Ends<input name="endsAt" type="datetime-local" required defaultValue={block?.endsAtLocal||(initialDate?`${initialDate}T${initialEndTime||"13:00"}`:"")} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"/></label>
   <label className="text-sm font-medium">Optional room reservation<select name="roomId" defaultValue={block?.room_id||""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"><option value="">Do not reserve a room</option>{rooms.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
   <label className="text-sm font-medium sm:col-span-2">Private note<textarea name="notes" rows={3} defaultValue={block?.notes||""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"/></label>
  </div>
  {!block?<div className="rounded-2xl border border-orange-100 bg-orange-50 p-4"><label className="flex items-center gap-2 text-sm font-semibold"><input name="isRecurring" type="checkbox" checked={recurring} onChange={e=>setRecurring(e.target.checked)}/>Repeat weekly</label>{recurring?<label className="mt-3 block text-sm font-medium">Number of weeks<input name="recurrenceCount" type="number" min="2" max="52" defaultValue="4" className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"/></label>:null}</div>:null}
  <div className="flex flex-wrap gap-3"><button className="rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white">{block?"Save block":"Block time"}</button>{block?<button formAction={deleteInstructorScheduleBlockAction} className="rounded-full border border-red-200 px-5 py-3 text-sm font-semibold text-red-700">Delete block</button>:null}</div>
 </form>;
}
