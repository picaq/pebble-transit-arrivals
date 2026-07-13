/*
 * config.js — Clay settings page shown in the Pebble phone app.
 *
 * IMPORTANT: these settings are consumed on the PHONE (src/pkjs/index.js
 * handles 'webviewclosed' itself and stores them in phone localStorage).
 * They are NOT sent to the watch as individual AppMessage keys, which is
 * why none of these messageKeys appear in package.json. The watch just
 * gets a "SettingsChanged" ping.
 */

module.exports = [
  {
    type: "heading",
    defaultValue: "Transit Glance"
  },
  {
    type: "text",
    defaultValue:
      "Live Bay Area arrivals on your wrist. Data from 511.org — get a " +
      "free API key at https://511.org/open-data/token (see the app README)."
  },
  {
    type: "section",
    items: [
      { type: "heading", defaultValue: "511.org API" },
      {
        type: "input",
        messageKey: "ApiKey",
        label: "API Key",
        defaultValue: "",
        attributes: {
          placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          type: "text"
        }
      }
    ]
  },
  {
    type: "section",
    items: [
      { type: "heading", defaultValue: "Agencies" },
      { type: "toggle", messageKey: "AgencySF", label: "SF Muni", defaultValue: true },
      { type: "toggle", messageKey: "AgencyBA", label: "BART", defaultValue: true },
      { type: "toggle", messageKey: "AgencyAC", label: "AC Transit", defaultValue: true },
      { type: "toggle", messageKey: "AgencyGG", label: "Golden Gate Transit", defaultValue: true },
      { type: "toggle", messageKey: "AgencySM", label: "SamTrans", defaultValue: true },
      {
        type: "input",
        messageKey: "ExtraAgencies",
        label: "Extra agency codes",
        defaultValue: "",
        description:
          "Comma-separated 511 operator codes to also search, e.g. CT for " +
          "Caltrain, SC for VTA. Full list: " +
          "api.511.org/transit/operators?api_key=KEY&format=json",
        attributes: { placeholder: "CT,SC" }
      }
    ]
  },
  {
    type: "section",
    items: [
      { type: "heading", defaultValue: "Nearby search" },
      {
        type: "slider",
        messageKey: "RadiusM",
        label: "Search radius (meters)",
        defaultValue: 500,
        min: 100,
        max: 4000,
        step: 100
      },
      {
        type: "slider",
        messageKey: "MaxStops",
        label: "Typical nearby stops",
        description:
          "Baseline stop count. Dense areas with many close-together stops " +
          "(e.g. a busy downtown intersection) may show more than this.",
        defaultValue: 8,
        min: 3,
        max: 12,
        step: 1
      },
      {
        type: "slider",
        messageKey: "HideFavKm",
        label: "Hide favorites beyond (km)",
        description:
          "Favorite stops farther away than this are left off the watch " +
          "list (and cost no API calls) until you're near them again. " +
          "They stay saved — see the Favorite stops section below.",
        defaultValue: 19,
        min: 1,
        max: 100,
        step: 1
      },
      {
        type: "slider",
        messageKey: "RailRadiusX",
        label: "BART/Caltrain distance multiplier",
        description:
          "How much farther a train is worth going than a bus (1 = the " +
          "same). BART and Caltrain stops — favorites and nearby ones " +
          "alike — are found this many times farther out, and are ranked " +
          "as if they were this many times closer: at 5×, a station 3 km " +
          "away sits among the 600 m bus stops in the list. Favorites also " +
          "stay on the list this many times past the hide distance above " +
          "(with 19 km: 5× = 95 km, 30× = 570 km — your starred station " +
          "stays on the watch for the whole ride). Distances shown on the " +
          "watch are always the real ones.",
        defaultValue: 1,
        min: 1,
        max: 30,
        step: 1
      }
    ]
  },
  // index.js appends a dynamic "Favorite stops" section (one remove-toggle
  // per saved favorite) before the submit button when favorites exist.
  {
    type: "submit",
    defaultValue: "Save Settings"
  }
];
