"use client";

import { useEffect } from "react";

export default function TimezoneFormatter() {
  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-timezone-date]").forEach((el) => {
      const value = el.dataset.timezoneDate;
      if (!value) return;

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return;

      el.textContent = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    });
  }, []);

  return null;
}