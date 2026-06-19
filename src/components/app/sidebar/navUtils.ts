import type { NavItem, NavSectionType } from "./types";

type NormalizeSectionsOptions = {
  hasOrganizerSuite?: boolean;
};

export function isActivePath(pathname: string, href: string) {
  if (href === "/app") {
    return pathname === "/app";
  }

  const eventOperationMatches: Record<string, RegExp[]> = {
    "/app/events": [
      /^\/app\/events$/,
      /^\/app\/events\/[^/]+$/,
      /^\/app\/events\/[^/]+\/edit$/,
      /^\/app\/events\/[^/]+\/private-lessons(?:\/.*)?$/,
    ],
    "/app/events/new": [/^\/app\/events\/new$/],
    "/app/events/tickets": [
      /^\/app\/events\/tickets$/,
      /^\/app\/events\/[^/]+\/tickets(?:\/.*)?$/,
    ],
    "/app/events/sell-tickets": [
      /^\/app\/events\/sell-tickets$/,
      /^\/app\/events\/[^/]+\/sell-tickets(?:\/.*)?$/,
    ],
    "/app/events/registrations": [
      /^\/app\/events\/registrations$/,
      /^\/app\/events\/[^/]+\/registrations(?:\/.*)?$/,
    ],
    "/app/events/checkin": [
      /^\/app\/events\/checkin$/,
      /^\/app\/events\/check-in$/,
      /^\/app\/events\/[^/]+\/checkin(?:\/.*)?$/,
      /^\/app\/events\/[^/]+\/check-in(?:\/.*)?$/,
    ],
  };

  const eventMatches = eventOperationMatches[href];
  if (eventMatches) {
    return eventMatches.some((pattern) => pattern.test(pathname));
  }

  const exactOnlyRoutes = new Set([
    "/app/clients/new",
    "/app/events/new",
    "/app/events/sell-tickets",
  ]);

  if (exactOnlyRoutes.has(href)) {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function normalizeNavLabel(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  if (item.href === "/app/aria" || lower === "aria") {
    return "Consult with ARIA";
  }

  if (item.href === "/app/reports" || lower === "reports") {
    return "Reports & Accounting";
  }

  if (item.href === "/app/packages") {
    return "Package Templates";
  }

  if (item.href === "/app/packages/sell") {
    return "Sell a Package";
  }

  if (item.href === "/app/memberships") {
    return "Membership Templates";
  }

  if (item.href === "/app/memberships/sell") {
    return "Sell a Membership";
  }

  if (item.href === "/app/events/sell-tickets") {
    return "Sell Event Tickets";
  }

  if (item.href === "/app/events/checkin" || item.href === "/app/events/check-in") {
    return "Event Check-In";
  }

  if (item.href === "/app/schedule/requests") {
    return "Booking Requests";
  }

  if (item.href === "/app/documents") {
    return "Waivers & Documents";
  }

  if (item.href === "/app/marketing" || item.href === "/app/campaigns") {
    return "Email Marketing";
  }


  if (
    item.href === "/app/settings/billing" ||
    lower === "billing" ||
    lower === "billing & payouts" ||
    lower === "payment settings"
  ) {
    return "Billing & Payouts";
  }

  if (
    lower === "discovery" ||
    lower === "discover" ||
    lower === "public discovery"
  ) {
    return "Discovery Home";
  }

  if (
    lower === "find studios" ||
    lower === "studios near me" ||
    lower === "discover studios"
  ) {
    return "Find Studios";
  }

  if (
    lower === "find events" ||
    lower === "events near me" ||
    lower === "discover events"
  ) {
    return "Find Events";
  }

  if (
    lower === "tickets" ||
    lower === "event tickets" ||
    lower === "manage event tickets"
  ) {
    return "Manage Tickets";
  }

  if (
    lower === "registrations" ||
    lower === "event registrations" ||
    lower === "manage registrations"
  ) {
    return "Registrations";
  }

  if (
    lower === "check in" ||
    lower === "check-in" ||
    lower === "event check-in"
  ) {
    return "Check-In";
  }

  return item.label;
}

function isDiscoveryHomeItem(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  return (
    item.href === "/discover" ||
    item.href === "/app/discover" ||
    lower === "discovery home" ||
    lower === "public discovery" ||
    lower === "discovery"
  );
}

function isRedundantDiscoveryChild(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  return (
    item.href === "/discover/studios" ||
    item.href === "/discover/events" ||
    item.href === "/app/discover/studios" ||
    item.href === "/app/discover/events" ||
    lower === "find studios" ||
    lower === "find events"
  );
}

function removeRedundantDiscoveryLinks(sections: NavSectionType[]) {
  const hasDiscoveryHome = sections.some((section) =>
    section.items.some(isDiscoveryHomeItem),
  );

  if (!hasDiscoveryHome) {
    return sections;
  }

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !isRedundantDiscoveryChild(item)),
    }))
    .filter((section) => section.items.length > 0);
}

function injectOrganizerCampaignsLink(
  sections: NavSectionType[],
  options: NormalizeSectionsOptions = {},
): NavSectionType[] {
  if (!options.hasOrganizerSuite) {
    return sections;
  }

  const flatItems = sections.flatMap((section) => section.items);
  const hasOrganizerCampaigns = flatItems.some(
    (item) => item.href === "/app/organizer-campaigns",
  );

  if (hasOrganizerCampaigns) {
    return sections;
  }

  const hasOrganizerAccess = flatItems.some(
    (item) =>
      item.href === "/app/organizers" ||
      item.href === "/app/organizer-contacts" ||
      item.href.startsWith("/app/organizers/"),
  );

  if (!hasOrganizerAccess) {
    return sections;
  }

  const organizerCampaignsItem: NavItem = {
    label: "Organizer Campaigns",
    href: "/app/organizer-campaigns",
    icon: "organizer_campaigns",
  };

  const organizerSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "organizers" ||
      title === "events" ||
      title === "marketing" ||
      section.items.some(
        (item) =>
          item.href === "/app/organizers" ||
          item.href === "/app/organizer-contacts",
      )
    );
  });

  if (organizerSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== organizerSectionIndex) {
        return section;
      }

      const organizerContactsIndex = section.items.findIndex(
        (item) => item.href === "/app/organizer-contacts",
      );

      if (organizerContactsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, organizerContactsIndex + 1),
            organizerCampaignsItem,
            ...section.items.slice(organizerContactsIndex + 1),
          ],
        };
      }

      const organizersIndex = section.items.findIndex(
        (item) => item.href === "/app/organizers",
      );

      if (organizersIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, organizersIndex + 1),
            organizerCampaignsItem,
            ...section.items.slice(organizersIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, organizerCampaignsItem],
      };
    });
  }

  return [
    ...sections,
    {
      title: "Organizers",
      items: [organizerCampaignsItem],
    },
  ];
}

function injectOrganizerContactsLink(
  sections: NavSectionType[],
  options: NormalizeSectionsOptions = {},
): NavSectionType[] {
  if (!options.hasOrganizerSuite) {
    return sections;
  }

  const flatItems = sections.flatMap((section) => section.items);
  const hasOrganizerContacts = flatItems.some(
    (item) => item.href === "/app/organizer-contacts",
  );

  if (hasOrganizerContacts) {
    return sections;
  }

  const hasOrganizerAccess = flatItems.some(
    (item) =>
      item.href === "/app/organizers" ||
      item.href.startsWith("/app/organizers/"),
  );

  if (!hasOrganizerAccess) {
    return sections;
  }

  const organizerContactsItem: NavItem = {
    label: "Organizer Contacts",
    href: "/app/organizer-contacts",
    icon: "organizer_contacts",
  };

  const organizerSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "organizers" ||
      title === "events" ||
      section.items.some((item) => item.href === "/app/organizers")
    );
  });

  if (organizerSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== organizerSectionIndex) {
        return section;
      }

      const organizersIndex = section.items.findIndex(
        (item) => item.href === "/app/organizers",
      );

      if (organizersIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, organizersIndex + 1),
            organizerContactsItem,
            ...section.items.slice(organizersIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, organizerContactsItem],
      };
    });
  }

  return [
    ...sections,
    {
      title: "Organizers",
      items: [organizerContactsItem],
    },
  ];
}

function injectSyllabusLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasSyllabus = flatItems.some((item) => item.href === "/app/syllabus");

  if (hasSyllabus) {
    return sections;
  }

  const syllabusItem: NavItem = {
    label: "Syllabus",
    href: "/app/syllabus",
    icon: "syllabus",
  };

  const peopleSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "people" ||
      title === "clients" ||
      title === "crm" ||
      section.items.some(
        (item) =>
          item.href === "/app/clients" ||
          item.href === "/app/leads" ||
          item.href === "/app/instructors",
      )
    );
  });

  if (peopleSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== peopleSectionIndex) {
        return section;
      }

      const clientsIndex = section.items.findIndex(
        (item) => item.href === "/app/clients",
      );

      if (clientsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, clientsIndex + 1),
            syllabusItem,
            ...section.items.slice(clientsIndex + 1),
          ],
        };
      }

      const instructorsIndex = section.items.findIndex(
        (item) => item.href === "/app/instructors",
      );

      if (instructorsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, instructorsIndex + 1),
            syllabusItem,
            ...section.items.slice(instructorsIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, syllabusItem],
      };
    });
  }

  const dashboardIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...sections.slice(0, dashboardIndex + 1),
      {
        title: "People",
        items: [syllabusItem],
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "People",
      items: [syllabusItem],
    },
    ...sections,
  ];
}

function injectEventWorkflowLinks(
  sections: NavSectionType[],
  options: NormalizeSectionsOptions = {},
): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasEventsAccess = flatItems.some((item) => item.href === "/app/events");

  if (!hasEventsAccess) {
    return sections;
  }

  const eventSection: NavSectionType = {
    title: "Events",
    items: [
      {
        label: "Events",
        href: "/app/events",
        icon: "events",
      },
      {
        label: "Create Event",
        href: "/app/events/new",
        icon: "events",
      },
      ...(options.hasOrganizerSuite
        ? [
            {
              label: "Manage Tickets",
              href: "/app/events/tickets",
              icon: "tickets",
            },
            {
              label: "Sell Tickets",
              href: "/app/events/sell-tickets",
              icon: "tickets",
            },
            {
              label: "Registrations",
              href: "/app/events/registrations",
              icon: "registrations",
            },
            {
              label: "Check-In",
              href: "/app/events/checkin",
              icon: "checkin",
            },
          ]
        : []),
    ],
  };

  const cleanedSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.href !== "/app/events" &&
          item.href !== "/app/events/new" &&
          item.href !== "/app/events/tickets" &&
          item.href !== "/app/events/sell-tickets" &&
          item.href !== "/app/events/registrations" &&
          item.href !== "/app/events/checkin",
      ),
    }))
    .filter((section) => section.items.length > 0);

  const salesAndPaymentsIndex = cleanedSections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "sales & payments" ||
      title === "sales and payments" ||
      title === "payments" ||
      section.items.some(
        (item) =>
          item.href.startsWith("/app/payments") ||
          item.href.startsWith("/app/packages") ||
          item.href.startsWith("/app/memberships"),
      )
    );
  });

  if (salesAndPaymentsIndex >= 0) {
    return [
      ...cleanedSections.slice(0, salesAndPaymentsIndex + 1),
      eventSection,
      ...cleanedSections.slice(salesAndPaymentsIndex + 1),
    ];
  }

  const dashboardIndex = cleanedSections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...cleanedSections.slice(0, dashboardIndex + 1),
      eventSection,
      ...cleanedSections.slice(dashboardIndex + 1),
    ];
  }

  return [eventSection, ...cleanedSections];
}

function injectDocumentsLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);

  if (flatItems.some((item) => item.href === "/app/documents")) {
    return sections;
  }

  const documentsItem: NavItem = {
    label: "Documents",
    href: "/app/documents",
    icon: "documents",
  };

  const peopleSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "people" ||
      title === "clients" ||
      title === "crm" ||
      section.items.some(
        (item) =>
          item.href === "/app/clients" ||
          item.href === "/app/syllabus" ||
          item.href === "/app/leads" ||
          item.href === "/app/instructors",
      )
    );
  });

  if (peopleSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== peopleSectionIndex) {
        return section;
      }

      const syllabusIndex = section.items.findIndex(
        (item) => item.href === "/app/syllabus",
      );
      const clientsIndex = section.items.findIndex(
        (item) => item.href === "/app/clients",
      );
      const instructorsIndex = section.items.findIndex(
        (item) => item.href === "/app/instructors",
      );
      const insertAfterIndex =
        syllabusIndex >= 0
          ? syllabusIndex
          : clientsIndex >= 0
            ? clientsIndex
            : instructorsIndex;

      if (insertAfterIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, insertAfterIndex + 1),
            documentsItem,
            ...section.items.slice(insertAfterIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, documentsItem],
      };
    });
  }

  const dashboardIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...sections.slice(0, dashboardIndex + 1),
      {
        title: "People",
        items: [documentsItem],
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "People",
      items: [documentsItem],
    },
    ...sections,
  ];
}

function injectAriaLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);

  if (flatItems.some((item) => item.href === "/app/aria")) {
    return sections;
  }

  const ariaItem: NavItem = {
    label: "Consult with ARIA",
    href: "/app/aria",
    icon: "aria",
  };

  const dashboardSectionIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== dashboardSectionIndex) {
        return section;
      }

      const dashboardIndex = section.items.findIndex(
        (item) => item.href === "/app",
      );

      if (dashboardIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, dashboardIndex + 1),
            ariaItem,
            ...section.items.slice(dashboardIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, ariaItem],
      };
    });
  }

  return [
    {
      title: "Studio",
      items: [ariaItem],
    },
    ...sections,
  ];
}

function injectAutomationsLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);

  if (flatItems.some((item) => item.href === "/app/automations")) {
    return sections;
  }

  const automationsItem: NavItem = {
    label: "Automations",
    href: "/app/automations",
    icon: "automations",
  };

  const operationsSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "operations" ||
      title === "growth" ||
      title === "marketing" ||
      section.items.some(
        (item) =>
          item.href === "/app/marketing" ||
          item.href === "/app/campaigns" ||
          item.href === "/app/notifications" ||
          item.href === "/app/reports",
      )
    );
  });

  if (operationsSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== operationsSectionIndex) {
        return section;
      }

      const notificationsIndex = section.items.findIndex(
        (item) => item.href === "/app/notifications",
      );
      const reportsIndex = section.items.findIndex(
        (item) => item.href === "/app/reports",
      );
      const marketingIndex = section.items.findIndex(
        (item) =>
          item.href === "/app/marketing" || item.href === "/app/campaigns",
      );
      const insertAfterIndex =
        notificationsIndex >= 0
          ? notificationsIndex
          : marketingIndex >= 0
            ? marketingIndex
            : reportsIndex;

      if (insertAfterIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, insertAfterIndex + 1),
            automationsItem,
            ...section.items.slice(insertAfterIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, automationsItem],
      };
    });
  }

  const dashboardIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...sections.slice(0, dashboardIndex + 1),
      {
        title: "Growth",
        items: [automationsItem],
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "Growth",
      items: [automationsItem],
    },
    ...sections,
  ];
}


function injectInstructorPayLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasInstructorPay = flatItems.some((item) => item.href === "/app/instructor-pay");

  if (hasInstructorPay) {
    return sections;
  }

  const instructorPayItem: NavItem = {
    label: "Instructor Pay",
    href: "/app/instructor-pay",
    icon: "payments",
  };

  const revenueSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "revenue" ||
      title === "billing" ||
      section.items.some(
        (item) =>
          item.href === "/app/payments" ||
          item.href === "/app/expenses" ||
          item.href === "/app/reports",
      )
    );
  });

  if (revenueSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== revenueSectionIndex) {
        return section;
      }

      const expensesIndex = section.items.findIndex((item) => item.href === "/app/expenses");
      const paymentsIndex = section.items.findIndex((item) => item.href === "/app/payments");
      const insertAfterIndex = expensesIndex >= 0 ? expensesIndex : paymentsIndex;

      if (insertAfterIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, insertAfterIndex + 1),
            instructorPayItem,
            ...section.items.slice(insertAfterIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, instructorPayItem],
      };
    });
  }

  const dashboardIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...sections.slice(0, dashboardIndex + 1),
      {
        title: "Revenue",
        items: [instructorPayItem],
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "Revenue",
      items: [instructorPayItem],
    },
    ...sections,
  ];
}

function injectDirectTaskLinks(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasHref = (href: string) => flatItems.some((item) => item.href === href);

  const additions: NavItem[] = [];

  if (hasHref("/app/clients") && !hasHref("/app/clients/new")) {
    additions.push({
      label: "Add Client",
      href: "/app/clients/new",
      icon: "clients",
    });
  }

  if (hasHref("/app/packages") && !hasHref("/app/packages/sell")) {
    additions.push({
      label: "Sell a Package",
      href: "/app/packages/sell",
      icon: "packages",
    });
  }

  if (hasHref("/app/memberships") && !hasHref("/app/memberships/sell")) {
    additions.push({
      label: "Sell a Membership",
      href: "/app/memberships/sell",
      icon: "memberships",
    });
  }

  if (hasHref("/app/reports") && !hasHref("/app/reports/client-birthdays")) {
    additions.push({
      label: "Birthday Outreach",
      href: "/app/reports/client-birthdays",
      icon: "reports",
    });
  }

  if (additions.length === 0) {
    return sections;
  }

  return [
    ...sections,
    {
      title: "Quick Actions",
      items: additions,
    },
  ];
}


function injectBookingRequestsLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasScheduleAccess = flatItems.some((item) => item.href === "/app/schedule");

  if (!hasScheduleAccess || flatItems.some((item) => item.href === "/app/schedule/requests")) {
    return sections;
  }

  const bookingRequestsItem: NavItem = {
    label: "Booking Requests",
    href: "/app/schedule/requests",
    icon: "schedule",
  };

  const scheduleSectionIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app/schedule"),
  );

  if (scheduleSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== scheduleSectionIndex) {
        return section;
      }

      const scheduleIndex = section.items.findIndex(
        (item) => item.href === "/app/schedule",
      );

      if (scheduleIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, scheduleIndex + 1),
            bookingRequestsItem,
            ...section.items.slice(scheduleIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, bookingRequestsItem],
      };
    });
  }

  return [
    {
      title: "Daily Operations",
      items: [bookingRequestsItem],
    },
    ...sections,
  ];
}

function routeKey(href: string) {
  return href.replace(/\/$/, "");
}

function uniqueNavItems(items: NavItem[]) {
  const seen = new Set<string>();
  const unique: NavItem[] = [];

  for (const item of items) {
    const key = routeKey(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      ...item,
      label: normalizeNavLabel(item),
    });
  }

  return unique;
}

function pickItems(
  available: Map<string, NavItem>,
  used: Set<string>,
  hrefs: string[],
) {
  const picked: NavItem[] = [];

  for (const href of hrefs) {
    const key = routeKey(href);
    const item = available.get(key);

    if (!item || used.has(key)) continue;

    picked.push(item);
    used.add(key);
  }

  return picked;
}

function makeSection(
  title: string,
  available: Map<string, NavItem>,
  used: Set<string>,
  hrefs: string[],
): NavSectionType | null {
  const items = pickItems(available, used, hrefs);
  return items.length > 0 ? { title, items } : null;
}

function optimizeNavigationForTasks(sections: NavSectionType[], options: NormalizeSectionsOptions = {}): NavSectionType[] {
  const originalItems = uniqueNavItems(sections.flatMap((section) => section.items));
  const available = new Map(originalItems.map((item) => [routeKey(item.href), item]));
  const used = new Set<string>();
  const optimized: NavSectionType[] = [];

  const orderedSections = [
    makeSection("Home", available, used, [
      "/app",
    ]),
    makeSection("Daily Operations", available, used, [
      "/app/schedule",
      "/app/schedule/requests",
      "/app/calendar",
      "/app/clients",
      "/app/clients/new",
      "/app/attendance",
      "/app/check-in",
      "/app/packages/sell",
      "/app/memberships/sell",
      ...(options.hasOrganizerSuite
        ? [
            "/app/events/sell-tickets",
            "/app/events/checkin",
            "/app/events/check-in",
          ]
        : []),
    ]),
    makeSection("Events", available, used, [
      "/app/events",
      "/app/events/new",
      ...(options.hasOrganizerSuite
        ? [
            "/app/events/tickets",
            "/app/events/registrations",
            "/app/organizers",
            "/app/organizer-contacts",
          ]
        : []),
    ]),
    makeSection("Revenue", available, used, [
      "/app/payments",
      "/app/packages",
      "/app/memberships",
      "/app/expenses",
      "/app/instructor-pay",
      "/app/balances",
      "/app/settings/billing",
    ]),
    makeSection("Growth", available, used, [
      "/app/leads",
      "/app/marketing",
      "/app/campaigns",
      ...(options.hasOrganizerSuite ? ["/app/organizer-campaigns"] : []),
      "/app/automations",
      "/app/reports/client-birthdays",
      "/app/discovery-profile",
      "/app/public-profile",
      "/app/profile",
      "/app/discover",
      "/app/discovery",
    ]),
    makeSection("Insights", available, used, [
      "/app/reports",
      "/app/aria",
    ]),
    makeSection("Studio Tools", available, used, [
      "/app/documents",
      "/app/syllabus",
      "/app/instructors",
      "/app/rooms",
      "/app/notifications",
      "/app/settings",
      "/app/support",
      "/app/knowledgebase",
    ]),
  ].filter((section): section is NavSectionType => Boolean(section));

  optimized.push(...orderedSections);

  const remainingByOriginalSection: NavSectionType[] = [];
  for (const section of sections) {
    const remainingItems = section.items.filter((item) => {
      const key = routeKey(item.href);
      if (used.has(key)) return false;
      used.add(key);
      return true;
    });

    if (remainingItems.length > 0) {
      remainingByOriginalSection.push({
        title: section.title,
        items: remainingItems,
      });
    }
  }

  if (remainingByOriginalSection.length > 0) {
    optimized.push(...remainingByOriginalSection);
  }

  return optimized;
}


export function normalizeSections(input: unknown, options: NormalizeSectionsOptions = {}): NavSectionType[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((section) => {
      const rawSection = section as Partial<NavSectionType> | null | undefined;
      const title =
        typeof rawSection?.title === "string" && rawSection.title.trim()
          ? rawSection.title
          : "Section";

      const items = Array.isArray(rawSection?.items)
        ? rawSection.items
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawItem = item as Partial<NavItem>;

              const normalizedItem = {
                label:
                  typeof rawItem.label === "string" && rawItem.label.trim()
                    ? rawItem.label
                    : "Item",
                href:
                  typeof rawItem.href === "string" && rawItem.href.trim()
                    ? rawItem.href
                    : "/app",
                icon:
                  typeof rawItem.icon === "string" && rawItem.icon.trim()
                    ? rawItem.icon
                    : "dashboard",
                badge:
                  typeof rawItem.badge === "number" ? rawItem.badge : undefined,
              } satisfies NavItem;

              return {
                ...normalizedItem,
                label: normalizeNavLabel(normalizedItem),
              } satisfies NavItem;
            })
        : [];

      return {
        title,
        items,
      } satisfies NavSectionType;
    })
    .filter((section) => section.items.length > 0);

  const withoutDiscoveryDuplicates = removeRedundantDiscoveryLinks(normalized);
  const withAriaLink = injectAriaLink(withoutDiscoveryDuplicates);
  const withEventWorkflowLinks = injectEventWorkflowLinks(withAriaLink, options);
  const withOrganizerContactsLink = injectOrganizerContactsLink(
    withEventWorkflowLinks,
    options,
  );
  const withOrganizerCampaignsLink = injectOrganizerCampaignsLink(
    withOrganizerContactsLink,
    options,
  );
  const withSyllabusLink = injectSyllabusLink(withOrganizerCampaignsLink);
  const withDocumentsLink = injectDocumentsLink(withSyllabusLink);
  const withAutomationsLink = injectAutomationsLink(withDocumentsLink);
  const withInstructorPayLink = injectInstructorPayLink(withAutomationsLink);
  const withBookingRequestsLink = injectBookingRequestsLink(withInstructorPayLink);
  const withDirectTaskLinks = injectDirectTaskLinks(withBookingRequestsLink);

  return optimizeNavigationForTasks(withDirectTaskLinks, options);
}

export function prettyRole(role: string) {
  return role.replaceAll("_", " ");
}
