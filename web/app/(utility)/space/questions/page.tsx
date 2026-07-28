import { redirect } from "next/navigation";

export default function SpaceQuestionsPage() {
  redirect("/knowledge?tab=papers");
}
