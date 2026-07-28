import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2, LogOut, ShieldCheck } from "lucide-react";
import {
  currentAccount,
  getSavedCreds,
  logout,
  requestCode,
  submitCode,
  submitPassword,
  type MtprotoAccount,
} from "@/lib/providers/mtproto";

type Step = "creds" | "code" | "password" | "done";

const input =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono";

export function TelegramAccountCard() {
  const [step, setStep] = useState<Step>("creds");
  const [account, setAccount] = useState<MtprotoAccount | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);

  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const creds = await getSavedCreds();
      if (creds && alive) {
        setApiId(String(creds.apiId));
        setApiHash(creds.apiHash);
      }
      const acc = await currentAccount();
      if (!alive) return;
      if (acc) {
        setAccount(acc);
        setStep("done");
      }
      setChecking(false);
    })();
    return () => { alive = false; };
  }, []);

  const err = (e: unknown) =>
    toast.error(e instanceof Error ? e.message : String(e));

  const sendCode = async () => {
    const id = Number(apiId.trim());
    if (!id || !apiHash.trim() || !phone.trim()) {
      toast.error("أكمل api_id و api_hash ورقم الهاتف");
      return;
    }
    setBusy(true);
    try {
      const res = await requestCode({ apiId: id, apiHash: apiHash.trim() }, phone.trim());
      setStep("code");
      toast.success(res.viaApp ? "أُرسل الرمز داخل تطبيق تليكرام" : "أُرسل الرمز عبر SMS");
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const verifyCode = async () => {
    setBusy(true);
    try {
      const r = await submitCode(code);
      if (r === "password") {
        setStep("password");
        toast.info("الحساب محمي بكلمة مرور (2FA)");
      } else {
        setAccount(await currentAccount());
        setStep("done");
        toast.success("تم ربط الحساب");
      }
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const verifyPassword = async () => {
    setBusy(true);
    try {
      await submitPassword(password);
      setAccount(await currentAccount());
      setStep("done");
      toast.success("تم ربط الحساب");
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await logout();
      setAccount(null);
      setCode("");
      setPassword("");
      setStep("creds");
      toast.success("تم فصل الحساب");
    } finally { setBusy(false); }
  };

  if (checking) {
    return (
      <section className="rounded-2xl border border-border bg-card p-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </section>
    );
  }

  // --- Connected: the whole tutorial disappears ------------------------------
  if (step === "done" && account) {
    return (
      <section className="rounded-2xl border border-primary/40 bg-primary/5 p-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/20 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold">الحساب الشخصي مرتبط</h2>
            <p className="truncate text-xs text-muted-foreground">
              {account.firstName ?? "حساب"}
              {account.username ? ` · @${account.username}` : ""}
              {account.phone ? ` · +${account.phone}` : ""}
            </p>
          </div>
          <button
            onClick={disconnect}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
            فصل
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="mb-1 text-sm font-bold">ربط حسابك الشخصي في تليكرام</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        الحساب الشخصي (MTProto) يتجاوز قيود البوت: يقرأ كل المحفوظات القديمة في القناة/المجموعة،
        وبدون وضع الخصوصية، وبحد ملفات أكبر. كل شيء يجري داخل جهازك ويُخزَّن محلياً فقط.
      </p>

      <ol className="mb-4 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <li className="flex gap-2">
          <b className="text-primary">1.</b>
          <span>
            افتح <a dir="ltr" href="https://my.telegram.org/auth" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary underline">my.telegram.org <ExternalLink className="h-3 w-3" /></a> وسجّل الدخول برقم هاتفك (سيصلك رمز داخل تليكرام).
          </span>
        </li>
        <li className="flex gap-2">
          <b className="text-primary">2.</b>
          <span>اضغط <b>API development tools</b> → املأ اسم التطبيق (أي اسم) واختر <b>Other</b> → <b>Create application</b>.</span>
        </li>
        <li className="flex gap-2">
          <b className="text-primary">3.</b>
          <span>انسخ <code dir="ltr">api_id</code> و <code dir="ltr">api_hash</code> وألصقهما بالأسفل مع رقم هاتفك بصيغة دولية <code dir="ltr">+9647xx…</code>.</span>
        </li>
        <li className="flex gap-2">
          <b className="text-primary">4.</b>
          <span>اضغط «إرسال الرمز» ثم أدخل الرمز الذي يصلك في تليكرام (وكلمة مرور 2FA إن وُجدت).</span>
        </li>
      </ol>

      {step === "creds" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">api_id</label>
          <input value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="1234567" dir="ltr" inputMode="numeric" className={input} />
          <label className="block text-xs font-medium text-muted-foreground">api_hash</label>
          <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="0123456789abcdef…" dir="ltr" className={input} />
          <label className="block text-xs font-medium text-muted-foreground">رقم الهاتف</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+9647xxxxxxxxx" dir="ltr" inputMode="tel" className={input} />
          <button
            onClick={sendCode}
            disabled={busy}
            className="mt-2 flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            إرسال الرمز
          </button>
        </div>
      )}

      {step === "code" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">رمز التحقق</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="12345" dir="ltr" inputMode="numeric" className={input} />
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={verifyCode}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              تأكيد
            </button>
            <button onClick={() => setStep("creds")} className="rounded-full bg-secondary px-4 py-2 text-sm font-semibold">
              رجوع
            </button>
          </div>
        </div>
      )}

      {step === "password" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">كلمة مرور التحقق بخطوتين (2FA)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" className={input} />
          <button
            onClick={verifyPassword}
            disabled={busy}
            className="mt-2 flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            تأكيد
          </button>
        </div>
      )}
    </section>
  );
}
