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
    "/app",
    "/app/aria",
    "/app/clients/new",
    "/app/events/new",
    "/app/events/sell-tickets",
    "/app/analytics",
    "/app/payments",
    "/app/payments/take",
  ]);

  if (exactOnlyRoutes.has(href)) {
    return pathname === href;
  }

  if (
    href === "/app/instructors" &&
    pathname.startsWith("/app/instructors/my-availability")
  ) {
    return false;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function normalizeNavLabel(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  if (item.href === "/app/aria/operations" || lower === "aria operations") {
    return "ARIA Operations";
  }

  if (item.href === "/app/aria" || lower === "aria") {
    return "Consult with ARIA";
  }

  if (item.href === "/app/analytics" || lower === "analytics" || lower === "studio analytics") {
    return "Studio Analytics";
  }

  if (
    item.href === "/app/analytics/dance-goals" ||
    lower === "dance goal analytics" ||
    lower === "dance goals analytics" ||
    lower === "goal analytics"
  ) {
    return "Dance Goal Analytics";
  }

  if (item.href === "/app/reports" || lower === "reports") {
    return "Reports & Accounting";
  }

  if (item.href === "/app/payments") {
    return "Payment Ledger";
  }


  if (item.href === "/app/sell" || item.href === "/app/sales/new") {
    return "Sell";
  }

  if (item.href === "/app/catalog") {
    return "Catalog";
  }

  if (item.href === "/app/orders") {
    return "Orders";
  }

  if (item.href === "/app/payments/take") {
    return "Take Payment";
  }

  if (item.href === "/app/packages") {
    return "Package Templates";
  }

  if (item.href === "/app/sales/new" || item.href === "/app/packages/sell") {
    return "Sell to Client";
  }

  if (item.href === "/app/memberships") {
    return "Membership Templates";
  }

  if (item.href === "/app/memberships/sell") {
    return "Sell to Client";
  }

  if (item.href === "/app/events/sell-tickets") {
    return "Sell Event Tickets";
  }

  if (item.href === "/app/events/checkin" || item.href === "/app/events/check-in") {
    return "Event Check-In";
  }

  if (item.href === "/app/schedule/requests" || item.href === "/app/schedule/self-service") {
    return "Self-service Requests";
  }

  if (item.href === "/app/documents") {
    return "Documents";
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
    item.href === "/app/now-hiring" ||
    lower === "now hiring" ||
    lower === "job postings" ||
    lower === "studio jobs"
  ) {
    return "Now Hiring";
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

function injectDiscoveryExpansionLinks(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const additions: NavItem[] = [];

  if (!flatItems.some((item) => item.href === "/app/now-hiring")) {
    additions.push({
      label: "Now Hiring",
      href: "/app/now-hiring",
      icon: "now_hiring",
    });
  }

  if (additions.length === 0) {
    return sections;
  }

  const discoverySectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "discovery" ||
      title === "public discovery" ||
      section.items.some(
        (item) =>
          item.href === "/app/discover" ||
          item.href === "/app/discovery" ||
          item.href === "/discover",
      )
    );
  });

  if (discoverySectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== discoverySectionIndex) {
        return section;
      }

      return {
        ...section,
        items: [...section.items, ...additions],
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
        title: "Discovery",
        items: additions,
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "Discovery",
      items: additions,
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

function injectAriaOperationsLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasAria = flatItems.some((item) => item.href === "/app/aria");
  const hasAriaOperations = flatItems.some(
    (item) => item.href === "/app/aria/operations",
  );

  if (!hasAria || hasAriaOperations) {
    return sections;
  }

  const ariaOperationsItem: NavItem = {
    label: "ARIA Operations",
    href: "/app/aria/operations",
    icon: "aria",
  };

  const ariaSectionIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app/aria"),
  );

  if (ariaSectionIndex < 0) {
    return [
      ...sections,
      {
        title: "Insights",
        items: [ariaOperationsItem],
      },
    ];
  }

  return sections.map((section, index) => {
    if (index !== ariaSectionIndex) {
      return section;
    }

    const ariaIndex = section.items.findIndex((item) => item.href === "/app/aria");

    if (ariaIndex < 0) {
      return {
        ...section,
        items: [...section.items, ariaOperationsItem],
      };
    }

    return {
      ...section,
      items: [
        ...section.items.slice(0, ariaIndex + 1),
        ariaOperationsItem,
        ...section.items.slice(ariaIndex + 1),
      ],
    };
  });
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



function injectCommerceLinks(sections: NavSectionType[]): NavSectionType[] {
  const commerceHrefs = new Set(["/app/sell", "/app/catalog", "/app/orders"]);
  const cleaned = sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          !commerceHrefs.has(item.href) &&
          item.href !== "/app/sales/new" &&
          item.href !== "/app/payments/quick-charge",
      ),
    }))
    .filter((section) => section.items.length > 0);

  const flatItems = cleaned.flatMap((section) => section.items);
  const hasSalesAccess = flatItems.some(
    (item) =>
      item.href === "/app/payments" ||
      item.href.startsWith("/app/packages") ||
      item.href.startsWith("/app/memberships"),
  );

  if (!hasSalesAccess) return cleaned;

  const commerceSection: NavSectionType = {
    title: "Commerce",
    items: [
      { label: "Sell", href: "/app/sell", icon: "sell" },
      { label: "Catalog", href: "/app/catalog", icon: "catalog" },
      { label: "Orders", href: "/app/orders", icon: "orders" },
    ],
  };

  const salesIndex = cleaned.findIndex((section) =>
    section.items.some(
      (item) =>
        item.href === "/app/payments" ||
        item.href.startsWith("/app/packages") ||
        item.href.startsWith("/app/memberships"),
    ),
  );

  if (salesIndex >= 0) {
    return [
      ...cleaned.slice(0, salesIndex),
      commerceSection,
      ...cleaned.slice(salesIndex),
    ];
  }

  return [commerceSection, ...cleaned];
}

function injectPaymentWorkflowLinks(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasPayments = flatItems.some((item) => item.href === "/app/payments");
  const hasTakePayment = flatItems.some((item) => item.href === "/app/payments/take");

  if (!hasPayments || hasTakePayment) {
    return sections;
  }

  const takePaymentItem: NavItem = {
    label: "Take Payment",
    href: "/app/payments/take",
    icon: "payments",
  };

  return sections.map((section) => {
    const paymentsIndex = section.items.findIndex(
      (item) => item.href === "/app/payments",
    );

    if (paymentsIndex < 0) {
      return section;
    }

    return {
      ...section,
      items: [
        ...section.items.slice(0, paymentsIndex),
        takePaymentItem,
        ...section.items.slice(paymentsIndex),
      ],
    };
  });
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

function injectDanceGoalAnalyticsLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasAnalytics = flatItems.some((item) => item.href === "/app/analytics");
  const hasDanceGoalAnalytics = flatItems.some(
    (item) => item.href === "/app/analytics/dance-goals",
  );

  if (!hasAnalytics || hasDanceGoalAnalytics) {
    return sections;
  }

  const danceGoalAnalyticsItem: NavItem = {
    label: "Dance Goal Analytics",
    href: "/app/analytics/dance-goals",
    icon: "reports",
  };

  const insightsSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "insights" ||
      title === "reports" ||
      section.items.some(
        (item) => item.href === "/app/analytics" || item.href === "/app/reports",
      )
    );
  });

  if (insightsSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== insightsSectionIndex) {
        return section;
      }

      const analyticsIndex = section.items.findIndex(
        (item) => item.href === "/app/analytics",
      );

      if (analyticsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, analyticsIndex + 1),
            danceGoalAnalyticsItem,
            ...section.items.slice(analyticsIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, danceGoalAnalyticsItem],
      };
    });
  }

  return [
    ...sections,
    {
      title: "Insights",
      items: [danceGoalAnalyticsItem],
    },
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

  if ((hasHref("/app/packages") || hasHref("/app/memberships")) && !hasHref("/app/sales/new")) {
    additions.push({
      label: "Sell to Client",
      href: "/app/sales/new",
      icon: "payments",
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

  if (
    !hasScheduleAccess ||
    flatItems.some(
      (item) =>
        item.href === "/app/schedule/self-service" ||
        item.href === "/app/schedule/requests",
    )
  ) {
    return sections;
  }

  const bookingRequestsItem: NavItem = {
    label: "Self-service Requests",
    href: "/app/schedule/self-service",
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

function injectMyAvailabilityLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasInstructorAccess = flatItems.some(
    (item) => item.href === "/app/instructors",
  );

  if (
    !hasInstructorAccess ||
    flatItems.some((item) => item.href === "/app/instructors/my-availability")
  ) {
    return sections;
  }

  const myAvailabilityItem: NavItem = {
    label: "My Availability",
    href: "/app/instructors/my-availability",
    icon: "instructors",
  };

  const studioToolsIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app/instructors"),
  );

  if (studioToolsIndex < 0) {
    return sections;
  }

  return sections.map((section, index) => {
    if (index !== studioToolsIndex) {
      return section;
    }

    const instructorsIndex = section.items.findIndex(
      (item) => item.href === "/app/instructors",
    );

    return {
      ...section,
      items: [
        ...section.items.slice(0, instructorsIndex + 1),
        myAvailabilityItem,
        ...section.items.slice(instructorsIndex + 1),
      ],
    };
  });
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

function workspaceForItem(item: NavItem) {
  const href = routeKey(item.href);

  if (href === "/app") return "Today";

  if (
    href.startsWith("/app/clients") ||
    href === "/app/leads" ||
    href === "/app/syllabus" ||
    href === "/app/documents" ||
    href === "/app/organizer-contacts"
  ) {
    return "Clients";
  }

  if (
    href.startsWith("/app/schedule") ||
    href.startsWith("/app/instructors") ||
    href.startsWith("/app/rooms") ||
    href === "/app/events/checkin" ||
    href === "/app/events/check-in"
  ) {
    return "Schedule";
  }

  if (
    href === "/app/sell" ||
    href === "/app/sales/new" ||
    href.startsWith("/app/catalog") ||
    href.startsWith("/app/orders") ||
    href.startsWith("/app/payments") ||
    href.startsWith("/app/packages") ||
    href.startsWith("/app/memberships") ||
    href.startsWith("/app/expenses") ||
    href.startsWith("/app/instructor-pay") ||
    href === "/app/events/sell-tickets" ||
    href === "/app/events/tickets"
  ) {
    return "Sell";
  }

  if (
    href.startsWith("/app/marketing") ||
    href.startsWith("/app/organizer-campaigns") ||
    href.startsWith("/app/automations") ||
    href.startsWith("/app/notifications")
  ) {
    return "Communications";
  }

  if (
    href.startsWith("/app/analytics") ||
    href.startsWith("/app/reports")
  ) {
    return "Reports";
  }

  if (href.startsWith("/app/aria")) return "ARIA";

  if (
    href.startsWith("/app/settings") ||
    href.startsWith("/app/account") ||
    href.startsWith("/app/help") ||
    href.startsWith("/app/support") ||
    href.startsWith("/knowledgebase") ||
    href.startsWith("/account") ||
    href.startsWith("/discover") ||
    href.startsWith("/app/organizers") ||
    href.startsWith("/app/events") ||
    href.startsWith("/app/now-hiring")
  ) {
    return "Settings";
  }

  return "Settings";
}

const WORKSPACE_ORDER = [
  "Today",
  "Clients",
  "Schedule",
  "Sell",
  "Communications",
  "Reports",
  "ARIA",
  "Settings",
] as const;

function itemPriority(section: (typeof WORKSPACE_ORDER)[number], href: string) {
  const priorities: Record<(typeof WORKSPACE_ORDER)[number], string[]> = {
    Today: ["/app"],
    Clients: [
      "/app/clients",
      "/app/leads",
      "/app/clients/new",
      "/app/documents",
      "/app/syllabus",
      "/app/organizer-contacts",
    ],
    Schedule: [
      "/app/schedule",
      "/app/schedule/self-service",
      "/app/instructors/my-availability",
      "/app/instructors",
      "/app/rooms",
      "/app/events/checkin",
      "/app/events/check-in",
    ],
    Sell: [
      "/app/sell",
      "/app/payments/take",
      "/app/orders",
      "/app/catalog",
      "/app/payments",
      "/app/packages",
      "/app/memberships",
      "/app/expenses",
      "/app/instructor-pay",
      "/app/events/sell-tickets",
      "/app/events/tickets",
    ],
    Communications: [
      "/app/marketing/campaigns",
      "/app/organizer-campaigns",
      "/app/automations",
      "/app/notifications",
    ],
    Reports: [
      "/app/analytics",
      "/app/analytics/dance-goals",
      "/app/reports",
      "/app/reports/client-birthdays",
    ],
    ARIA: ["/app/aria", "/app/aria/operations"],
    Settings: [
      "/app/settings",
      "/app/settings/team",
      "/app/settings/billing",
      "/app/organizers",
      "/app/events",
      "/app/events/new",
      "/app/now-hiring",
      "/discover",
      "/account",
      "/app/help",
      "/knowledgebase",
    ],
  };

  const index = priorities[section].indexOf(routeKey(href));
  return index >= 0 ? index : priorities[section].length + 100;
}

function optimizeNavigationForTasks(
  sections: NavSectionType[],
  _options: NormalizeSectionsOptions = {},
): NavSectionType[] {
  const items = uniqueNavItems(sections.flatMap((section) => section.items));
  const grouped = new Map<string, NavItem[]>();

  for (const title of WORKSPACE_ORDER) grouped.set(title, []);

  for (const item of items) {
    const workspace = workspaceForItem(item);
    grouped.get(workspace)?.push(item);
  }

  return WORKSPACE_ORDER.map((title) => {
    const workspaceItems = grouped.get(title) ?? [];
    const indexedItems = workspaceItems.map((item, index) => ({ item, index }));

    indexedItems.sort((a, b) => {
      const priorityDelta =
        itemPriority(title, a.item.href) - itemPriority(title, b.item.href);
      return priorityDelta !== 0 ? priorityDelta : a.index - b.index;
    });

    return {
      title,
      items: indexedItems.map(({ item }) =>
        item.href === "/app" ? { ...item, label: "Today" } : item,
      ),
    } satisfies NavSectionType;
  }).filter((section) => section.items.length > 0);
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
  const withAriaOperationsLink = injectAriaOperationsLink(withAriaLink);
  const withEventWorkflowLinks = injectEventWorkflowLinks(withAriaOperationsLink, options);
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
  const withCommerceLinks = injectCommerceLinks(withAutomationsLink);
  const withPaymentWorkflowLinks = injectPaymentWorkflowLinks(withCommerceLinks);
  const withInstructorPayLink = injectInstructorPayLink(withPaymentWorkflowLinks);
  const withDanceGoalAnalyticsLink = injectDanceGoalAnalyticsLink(withInstructorPayLink);
  const withBookingRequestsLink = injectBookingRequestsLink(withDanceGoalAnalyticsLink);
  const withMyAvailabilityLink = injectMyAvailabilityLink(withBookingRequestsLink);
  const withDirectTaskLinks = injectDirectTaskLinks(withMyAvailabilityLink);
  const withDiscoveryExpansionLinks = injectDiscoveryExpansionLinks(withDirectTaskLinks);

  return optimizeNavigationForTasks(withDiscoveryExpansionLinks, options);
}

export function prettyRole(role: string) {
  return role.replaceAll("_", " ");
}
