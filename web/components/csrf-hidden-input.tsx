import { CSRF_FORM_FIELD_NAME } from "@/app/lib/csrf-shared";

export default function CsrfHiddenInput({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={token} />;
}
