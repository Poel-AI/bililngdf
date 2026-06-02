/**
 * UNITE US WEBSITE SELECTORS & ELEMENT CONFIG (source of truth)
 * =============================================================
 * Edit here, then copy to: project root uniteSelectors.js and modules/uniteSelectors.js
 * so extension and server can be shipped separately with their own copy.
 *
 * Central config for all DOM elements we interact with on app.uniteus.io and
 * app.auth.uniteus.io. When the Unite site is updated, adjust values here
 * instead of hunting through auth.js, billingActions.js, etc.
 *
 * WHEN THE UNITE SITE UPDATES:
 * 1. Inspect the changed page (login, billing form, date picker, etc.).
 * 2. Update the matching section below (auth.*, billing.*) with new ids, XPaths,
 *    class names, or button text. Comments explain what each part is for.
 * 3. No need to touch auth.js, billingActions.js, or billingWorker.js unless
 *    you add new element types.
 *
 * CONVENTIONS:
 * - id: element id (e.g. user_email) — we add # when building selectors
 * - xpath: full XPath fallback when ID changes
 * - selectors: array of CSS/XPath strings; we try each until one matches
 * - class names: stored without leading dot; we add . when querying
 */

(function () {
  'use strict';
  const UNITE_SELECTORS = {
  // ---------------------------------------------------------------------------
  // URLS
  // ---------------------------------------------------------------------------
  urls: {
    /** Auth/login page. User enters email here, then clicks Next -> /login. */
    login: 'https://app.auth.uniteus.io/',
    /** Hit this before login to clear any existing Unite session. */
    logout: 'https://app.uniteus.io/logout'
  },

  // ---------------------------------------------------------------------------
  // AUTH / LOGIN (auth.js)
  // Used on app.auth.uniteus.io. Playwright uses these selectors via page.$(s).
  // ---------------------------------------------------------------------------
  auth: {
    /** Email input on initial auth page. */
    email: {
      selectors: [
        '#user_email',
        'input[name="user[email]"]',
        '//html/body/div[2]/div/form/div[1]/input',
        'input[type="email"]'
      ]
    },
    /** "Next" button after email. Triggers redirect to /login. */
    nextButton: {
      selectors: [
        '#auth-0-submit-btn',
        'input[name="commit"][value="Next"]',
        '//html/body/div[2]/div/form/div[2]/input',
        'input[type="submit"]'
      ]
    },
    /** Password input on /login page. */
    password: {
      selectors: [
        '#app_1_user_password',
        'input[name="app_1_user[password]"]',
        '//html/body/div[2]/div/form/div[2]/input',
        'input[type="password"]'
      ]
    },
    /** "Sign in" button on /login page. Submits credentials. */
    signIn: {
      selectors: [
        '#auth-1-submit-btn',
        'input[name="commit"][value="Sign in"]',
        '//html/body/div[2]/div/form/div[3]/input',
        'input[type="submit"][value="Sign in"]',
        'input[type="submit"]',
        'button[type="submit"]'
      ]
    },

    /**
     * Optional multi-organization picker on https://app.uniteus.io/ after password.
     * If the account only has one org, this UI does not appear.
     */
    groupSelector: {
      choicesContainer: '.group-selector__choices',
      itemButton: 'button.group-selector-item',
      /** Substring of aria-label / button text (case-insensitive), e.g. "Futures Essentials Inc - SCN - PHS". */
      preferredChoiceLabel: 'Futures Essentials'
    }
  },

  // ---------------------------------------------------------------------------
  // BILLING PAGE (billingActions.js – runs inside page.evaluate)
  // All IDs, XPaths, classes, and text fallbacks for the billing/case contact UI.
  // ---------------------------------------------------------------------------
  billing: {
    // ----- Page ready / Authorized table -------------------------------------
    /** Selector we wait for before running billing (billingWorker + injected). */
    pageReady: {
      /** Primary: table cell showing authorized service delivery date. */
      id: 'basic-table-authorized-service-delivery-date-s-value',
      /** XPath for "UniteUs ready" (panel wait). */
      xpath: '//*[@id="container"]/div[2]/main/div/section/div'
    },
    /** Authorized limits table: date range, max amount, date opened, service type. Used for clamping and per-person amount. */
    authorizedTable: {
      date: {
        id: 'basic-table-authorized-service-delivery-date-s-value',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[1]/div[2]/div[3]/div/div[1]/div/table/tbody/tr[3]/td[2]'
      },
      amount: {
        id: 'basic-table-authorized-amount-value',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[1]/div[2]/div[3]/div/div[1]/div/table/tbody/tr[2]'
      },
      dateOpened: {
        id: 'basic-table-date-opened-value',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[1]/div[2]/div[1]/div[1]/div/table/tbody/tr[3]/td[2]'
      },
      /** Service Type e.g. "Produce Prescription/Voucher" or "Medically Tailored Meals". If text contains "produce" → $146/person, else $336/person. */
      serviceType: {
        id: 'basic-table-service-type-value',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[1]/div[2]/div[1]/div[1]/div/table/tbody/tr[1]/td[2]'
      }
    },

    // ----- Add button & billing shelf ----------------------------------------
    /** Button that opens the "Add fee schedule / provided service" shelf. */
    addButton: {
      id: 'add-fee-schedule-service-provided-button',
      xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[1]/div/button',
      /** Fallback: button whose text contains this (case-insensitive). */
      textContains: 'add new contracted service'
    },
    /** Amount input in the shelf form. Also used to detect "shelf is open". */
    amount: {
      id: 'provided-service-unit-amount',
      xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div[2]/div/form/div[3]/div[1]/div/input'
    },
    /** Cancel button to close the shelf (optional; we rarely use it). */
    cancelButton: {
      id: 'fee-schedule-provided-service-cancel-btn'
    },

    // ----- Duplicate detection (existing billing cards) ----------------------
    /** Scans existing cards to detect duplicate date-range + amount. */
    duplicateScan: {
      /** Card container class for each billing entry. */
      cardClass: 'fee-schedule-provided-service-card',
      /** data-test-element for amount shown on card. */
      amountDataTest: 'unit-amount-value',
      /** data-test-element for date range; alternate if they use start-only. */
      datesDataTest: ['service-dates-value', 'service-start-date-value']
    },

    // ----- Period of Service (Single Date vs Date Range) ---------------------
    /** Must select "Date Range" radio before the range picker is visible. */
    periodOfService: {
      /** Radio input id for "Date Range" (so we get the two-calendar / range UI). */
      singleDateRadioId: 'provided-service-period-of-service-0',
      singleDateLabelText: 'Single Date',
      dateRangeRadioId: 'provided-service-period-of-service-1',
      /** Label text for fallback find. */
      dateRangeLabelText: 'Date Range',
      /** Label span id (for click fallback). */
      dateRangeLabelId: 'Date Range-label',
      xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/fieldset'
    },

    /** Brooklyn: one service date on #provided-service-date (Period of Service = Single Date). */
    singleDate: {
      inputId: 'provided-service-date',
      yearInputId: 'provided-service-date-year-input',
      labelXpath: "//label[@for='provided-service-date']",
      calendarTrigger: 'a[aria-controls="provided-service-date"]',
      container: '.ui-date-field',
      dropdownClass: 'ui-date-field__dropdown',
      dropdownOpenClass: 'ui-date-field__dropdown--open',
      navPrev: '.ui-date-field__controls a[role="button"]:first-of-type',
      navNext: '.ui-date-field__controls a[role="button"]:last-of-type',
      monthSpan: '.ui-date-field__controls div span',
      calendar: '.ui-date-field__dropdown .ui-calendar',
      dayButton: '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]'
    },

    /** Brooklyn: interaction note on billing form. */
    interactionNote: {
      id: 'interactionNote',
      name: 'provided_service.note'
    },

    // ----- Date range / Service Date picker ----------------------------------
    /** Service Date field (single-date or range). DOM updated: ui-date-field (was ui-duration-field). */
    dateRange: {
      /** Trigger has no id; we open via triggerXpath, fakeInput.roleButton, or label. */
      buttonId: '',
      /** Label has for="provided-service-date"; no id on label. */
      labelId: '',
      labelXpath: "//label[@for='provided-service-date']",
      /** Calendar open button (a[role="button"]) when Date Range is selected. */
      triggerXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[1]/a',
      /** Rewritten UI: start/end text inputs (MM/DD/YYYY) after opening; then press Enter. */
      startInputId: 'provided-service-dates-start',
      startInputXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[1]',
      endInputId: 'provided-service-dates-end',
      endInputXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[2]',
      /** Legacy calendar UI (when start/end inputs are not present). */
      startYearId: 'provided-service-date-year-input',
      endYearId: 'provided-service-date-year-input',
      /** Dropdown open state (class on dropdown when expanded). */
      dropdownOpenClass: 'ui-date-field__dropdown--open',
      /** Trigger and input to open the picker. */
      fakeInput: {
        roleButton: 'a[aria-controls="provided-service-date"]',
        value: 'input#provided-service-date',
        container: '.ui-date-field'
      },
      /** Dropdown container. */
      dropdownClass: 'ui-date-field__dropdown',
      /** Prev/next month inside .ui-date-field__controls. */
      navPrev: 'a[role="button"]:first-of-type',
      navNext: 'a[role="button"]:last-of-type',
      /** Single calendar (same selector for both; we navigate month then click start/end). */
      leftCalendar: '.ui-calendar',
      rightCalendar: '.ui-calendar',
      /** Single month label in controls. */
      leftSpan: '.ui-date-field__controls div span',
      rightSpan: '.ui-date-field__controls div span',
      /** Clickable day cells. */
      dayButton: '.ui-calendar__day div[role="button"]',
      /** Duration-field calendar UI (two panes, prev/next) – use this when present for calendar-click flow. */
      durationDropdown: '.ui-duration-field__dropdown',
      durationPrev: '.ui-duration-field__controls a[role="button"]:first-of-type',
      durationNext: '.ui-duration-field__controls a[role="button"]:last-of-type',
      durationCalLeft: '.ui-duration-field__calendars .ui-calendar:nth-of-type(1)',
      durationCalRight: '.ui-duration-field__calendars .ui-calendar:nth-of-type(2)',
      durationDayButton: '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]',
      durationStartYearId: 'provided-service-dates-start-year',
      durationEndYearId: 'provided-service-dates-end-year',
      /** Date-field two-pane calendar (when DOM uses ui-date-field instead of ui-duration-field). */
      dateFieldCalendars: '.ui-date-field__calendars .ui-calendar',
      dateFieldControls: '.ui-date-field__controls'
    },

    // ----- Place of Service (dropdown) ---------------------------------------
    /**
     * "Place of Service" Choices.js dropdown. We always choose "12 - Home".
     * Structure moved: form layout changed from .../div[2]/div[2]/... to .../div[2]/div/div[2]/...
     * xpath targets the dropdown container: div.choices__list.choices__list--dropdown
     * (contains input.choices__input.choices__input--cloned + div.choices__list[role="listbox"] with options).
     */
    placeOfService: {
      id: 'provided-service-place_of_service',
      xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[5]/div[2]/div/div[1]/div/div[2]',
      /** Option we select. */
      homeText: '12 - Home',
      homeValue: 'c0d441b4-ba1b-4f68-93af-a4d7d6659fba',
      /** Choices.js: dropdown container, listbox, options, search input. */
      choices: {
        inner: '.choices__inner',
        listDropdown: '.choices__list--dropdown .choices__list[role="listbox"]',
        listDropdownExpanded: '.choices__list--dropdown[aria-expanded="true"] .choices__list[role="listbox"]',
        option: '.choices__item[role="option"]',
        searchInput: '.choices__input.choices__input--cloned',
        searchInputAlt: 'input[type="text"].choices__input',
        singleSelected: '.choices__list--single .choices__item'
      }
    },

    // ----- Proof / document upload -------------------------------------------
    /** Attach proof documents. Button opens modal; we then set file input. */
    proofUpload: {
      /** Button text we match (must be visible). */
      attachButtonText: 'Attach Document',
      /** Modal dialog. */
      modal: {
        id: 'upload-payments-documents',
        classFallback: 'dialog-paper',
        roleFallback: '[role="dialog"]'
      },
      /** File input inside modal. */
      fileInput: {
        dataTestId: 'file-upload-input',
        typeFallback: 'input[type="file"]'
      },
      /** Save/Attach button in modal. Wait until not disabled before clicking. */
      saveButtonClass: 'attach-document-dialog__actions--save',
      /** Save button is disabled when it has this class. */
      disabledClass: 'opacity-40'
    },

    // ----- Dependants (household members) ------------------------------------
    /** Textareas for dependant names, DOBs, CINs. Multi-line formatted. */
    dependants: {
      name: {
        id: 'household_member_name_s_first_and_last',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div[2]/div/form/div[5]/div[3]/div/textarea'
      },
      dob: {
        id: 'household_member_date_of_birth_s',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div[2]/div/form/div[5]/div[4]/div/textarea'
      },
      cin: {
        id: 'household_member_cin_s',
        xpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div[2]/div/form/div[5]/div[5]/div/textarea'
      }
    },

    // ----- Submit ------------------------------------------------------------
    /** Submit button to post the billing record. */
    submit: {
      id: 'fee-schedule-provided-service-post-note-btn',
      /** When true, skip submit + verification (dev only). Set to false for production. */
      devSkipSubmit: false
    }
  }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UNITE_SELECTORS;
  } else if (typeof window !== 'undefined') {
    window.UNITE_SELECTORS = UNITE_SELECTORS;
  } else {
    self.UNITE_SELECTORS = UNITE_SELECTORS;
  }
})();
