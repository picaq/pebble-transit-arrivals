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
        max: 2000,
        step: 100
      },
      {
        type: "slider",
        messageKey: "MaxStops",
        label: "Max nearby stops",
        defaultValue: 8,
        min: 3,
        max: 12,
        step: 1
      }
    ]
  },
  {
    type: "submit",
    defaultValue: "Save Settings"
  }
];
