import { redirect } from 'next/navigation';

/** Library updates now live in the Library page. */
export default function UpdatesPage() {
  redirect('/library?view=updates');
}
