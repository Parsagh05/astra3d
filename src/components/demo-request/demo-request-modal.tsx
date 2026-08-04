"use client";

import { ArrowRight, Check, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";

import type { ExperienceIndustry, LeadRequest } from "@/types/platform";

import styles from "./demo-request.module.css";

type DemoRequestModalProps = {
  open: boolean;
  onClose: () => void;
};

type FormValues = Omit<LeadRequest, "industry"> & {
  industry: ExperienceIndustry | "Other" | "";
};

type FormErrors = Partial<Record<keyof FormValues, string>>;

const initialValues: FormValues = {
  fullName: "",
  workEmail: "",
  company: "",
  industry: "",
  message: "",
};

const industries: Array<ExperienceIndustry | "Other"> = [
  "Retail",
  "Real Estate",
  "Hospitality",
  "Art",
  "Other",
];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function DemoRequestModal({ open, onClose }: DemoRequestModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [values, setValues] = useState<FormValues>(initialValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const closeAndReset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
    setSubmitted(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      closeAndReset();
    };

    document.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [closeAndReset, open]);

  useEffect(() => {
    if (!open || !submitted) return;

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [open, submitted]);

  if (!open) return null;

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeAndReset();
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const updateValue = (field: keyof FormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const validate = () => {
    const nextErrors: FormErrors = {};

    if (values.fullName.trim().length < 2) {
      nextErrors.fullName = "Enter your full name.";
    }
    if (!emailPattern.test(values.workEmail.trim())) {
      nextErrors.workEmail = "Enter a valid work email.";
    }
    if (values.company.trim().length < 2) {
      nextErrors.company = "Enter your company or studio name.";
    }
    if (!values.industry) {
      nextErrors.industry = "Choose the experience you want to build.";
    }

    return nextErrors;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate();

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      const firstInvalidField = Object.keys(nextErrors)[0];
      dialogRef.current
        ?.querySelector<HTMLElement>(`[name="${firstInvalidField}"]`)
        ?.focus();
      return;
    }

    setSubmitted(true);
  };

  const scrollToExperiences = () => {
    closeAndReset();
    window.requestAnimationFrame(() => {
      document.querySelector("#experiences")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  };

  return (
    <div className={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleDialogKeyDown}
      >
        <button
          className={styles.closeButton}
          type="button"
          aria-label="Close demo request"
          onClick={closeAndReset}
        >
          <X aria-hidden="true" />
        </button>

        {submitted ? (
          <div className={styles.success} role="status" aria-live="polite">
            <span className={styles.successIcon} data-autofocus tabIndex={-1}>
              <Check aria-hidden="true" />
            </span>
            <p className={styles.eyebrow}>Brief complete</p>
            <h2 id={titleId}>Your next world has a starting point.</h2>
            <p id={descriptionId}>
              Thanks, {values.fullName.split(" ")[0]}. This front-end preview
              keeps your details in this browser and has not transmitted them.
            </p>
            <div className={styles.successActions}>
              <button className="button" type="button" onClick={scrollToExperiences}>
                Explore experiences <ArrowRight aria-hidden="true" />
              </button>
              <button className="button button--ghost" type="button" onClick={closeAndReset}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.intro}>
              <p className={styles.eyebrow}>Book a spatial demo</p>
              <h2 id={titleId}>Tell us where you want to take people.</h2>
              <p id={descriptionId}>
                Share the shape of your idea. We&apos;ll turn it into a focused
                starting brief for an immersive Astra3D experience.
              </p>
            </div>

            <form className={styles.form} noValidate onSubmit={handleSubmit}>
              <Field
                label="Full name"
                name="fullName"
                value={values.fullName}
                error={errors.fullName}
                autoComplete="name"
                autoFocus
                onChange={(value) => updateValue("fullName", value)}
              />
              <Field
                label="Work email"
                name="workEmail"
                type="email"
                value={values.workEmail}
                error={errors.workEmail}
                autoComplete="email"
                onChange={(value) => updateValue("workEmail", value)}
              />
              <Field
                label="Company or studio"
                name="company"
                value={values.company}
                error={errors.company}
                autoComplete="organization"
                onChange={(value) => updateValue("company", value)}
              />

              <label className={styles.field}>
                <span>Industry</span>
                <select
                  name="industry"
                  value={values.industry}
                  aria-invalid={Boolean(errors.industry)}
                  aria-describedby={errors.industry ? "industry-error" : undefined}
                  onChange={(event) => updateValue("industry", event.target.value)}
                >
                  <option value="">Choose one</option>
                  {industries.map((industry) => (
                    <option value={industry} key={industry}>
                      {industry}
                    </option>
                  ))}
                </select>
                {errors.industry ? (
                  <small className={styles.error} id="industry-error">
                    {errors.industry}
                  </small>
                ) : null}
              </label>

              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span>What should the experience achieve? <i>Optional</i></span>
                <textarea
                  name="message"
                  rows={3}
                  value={values.message}
                  onChange={(event) => updateValue("message", event.target.value)}
                />
              </label>

              <div className={styles.formFooter}>
                <p>
                  Preview flow only. No information leaves this page until a
                  delivery endpoint is connected.
                </p>
                <button className="button" type="submit">
                  Prepare my brief <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

type FieldProps = {
  label: string;
  name: "fullName" | "workEmail" | "company";
  value: string;
  error?: string;
  type?: "text" | "email";
  autoComplete: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
};

function Field({
  label,
  name,
  value,
  error,
  type = "text",
  autoComplete,
  autoFocus = false,
  onChange,
}: FieldProps) {
  const errorId = `${name}-error`;

  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        data-autofocus={autoFocus ? "true" : undefined}
        name={name}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <small className={styles.error} id={errorId}>
          {error}
        </small>
      ) : null}
    </label>
  );
}
