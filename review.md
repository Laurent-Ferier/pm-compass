Manifest

    Error
    - [x] Plugin description must not include the word "Obsidian".The word "Obsidian" in the description is redundant. It is implied by the context of the plugin directory.manifest.json:6

Releases

    Error
    - [x] The main.js release asset has an attestation that failed cryptographic verification.The attestation exists but its signature is invalid or does not match this repository. This may indicate the file was not built from this repository's source code. Learn more
    Error
    - [x] The styles.css release asset has an attestation that failed cryptographic verification.The attestation exists but its signature is invalid or does not match this repository. This may indicate the file was not built from this repository's source code. Learn more
    Recommendation
    - [x] The release has no description. Release notes help users understand what changed.

Network requests

    Pass
    - [x] No suspicious network patterns found.

Behavior

    Recommendation
    - [ ] Vault Enumeration: Enumerates all files in the vault (vault.getFiles, getMarkdownFiles, etc.). Gives the plugin access to every file path in the vault.
    Pass
    - [x] Vault Read: Reads individual vault files via the Obsidian API (vault.read, vault.cachedRead)
    Pass
    - [x] Vault Write: Creates or modifies vault files via the Obsidian API (vault.modify, vault.create, etc.)

Source code

    Error
    - [x] Unexpected undescribed directive comment. Include descriptions to explain why the comment is necessary.src/model/day-markdown-file.ts:12src/model/day-markdown-file.ts:30src/model/day-markdown-file.ts:177src/model/day-task-actions.ts:2src/model/day-task-actions.ts:70src/model/day-task-actions.ts:88src/model/day-task-actions.ts:109src/model/day-task-actions.ts:145src/model/recurring-task-backfill.ts:2src/model/recurring-task-backfill.ts:38src/model/task-scoring.ts:2src/model/week-summary.ts:2src/model/week-summary.ts:69src/ui/dashboard-view.ts:3src/ui/dashboard-view.ts:30src/ui/dashboard-view.ts:37src/ui/dashboard-view.ts:89src/ui/dashboard-view.ts:125src/ui/dashboard-view.ts:149src/ui/day-task-row.ts:2src/ui/day-task-row.ts:288src/ui/day-task-row.ts:305src/ui/pm-compass-view.ts:133src/ui/week-summary-view.ts:2
    Error
    - [x] Disabling '@typescript-eslint/no-explicit-any' is not allowed.src/model/day-markdown-file.ts:12src/model/day-markdown-file.ts:30src/model/day-markdown-file.ts:177src/model/day-task-actions.ts:2src/model/day-task-actions.ts:70src/model/day-task-actions.ts:88src/model/day-task-actions.ts:109src/model/day-task-actions.ts:145src/model/recurring-task-backfill.ts:2src/model/recurring-task-backfill.ts:38src/model/task-scoring.ts:2src/model/week-summary.ts:2src/model/week-summary.ts:69src/ui/dashboard-view.ts:3src/ui/dashboard-view.ts:30src/ui/dashboard-view.ts:37src/ui/dashboard-view.ts:89src/ui/dashboard-view.ts:125src/ui/dashboard-view.ts:149src/ui/day-task-row.ts:2src/ui/day-task-row.ts:288src/ui/day-task-row.ts:305src/ui/pm-compass-view.ts:133src/ui/week-summary-view.ts:2
    Error
    - [x] Sets styles directly instead of using CSS classes, setCssProps, or setCssStylesobsidianmd/no-static-styles-assignmentsrc/ui/base-tab-view.ts:69src/ui/task-creator.ts:435src/ui/task-creator.ts:440src/ui/task-creator.ts:453src/ui/task-creator.ts:625src/ui/task-graph-view.ts:322src/ui/task-graph-view.ts:356src/ui/task-graph-view.ts:627src/ui/task-graph-view.ts:628
    Warning
    - [x] Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the void operator.src/main.ts:145src/main.ts:150src/main.ts:156src/main.ts:161src/ui/base-tab-view.ts:267src/ui/task-creator.ts:163
    Warning
    - [x] Unsafe assignment of an error or any typed value@typescript-eslint/no-unsafe-assignmentsrc/model/day-markdown-file.ts:13src/model/day-markdown-file.ts:65src/model/day-markdown-file.ts:180src/model/day-task-actions.ts:3src/model/day-task-actions.ts:93src/model/day-task-actions.ts:150src/model/project-task-file.ts:121src/model/project-task-file.ts:197src/model/project-task-file.ts:208src/model/project-task-file.ts:234src/model/project-task-file.ts:253src/model/project-task-file.ts:290src/model/recurring-task-backfill.ts:3src/model/recurring-task-backfill.ts:26src/model/recurring-task-backfill.ts:48src/model/task-scoring.ts:3src/model/task-scoring.ts:9src/model/task-scoring.ts:10src/model/task-scoring.ts:11src/model/task-scoring.ts:22src/model/task-scoring.ts:23src/model/task-scoring.ts:24src/model/task-scoring.ts:67src/model/task-scoring.ts:72src/model/task-scoring.ts:79src/model/week-summary.ts:3src/model/week-summary.ts:71src/model/week-summary.ts:74src/model/week-summary.ts:75src/model/week-summary.ts:76src/ui/dashboard-view.ts:4src/ui/dashboard-view.ts:38src/ui/dashboard-view.ts:52src/ui/dashboard-view.ts:55src/ui/dashboard-view.ts:58src/ui/dashboard-view.ts:65src/ui/dashboard-view.ts:69src/ui/dashboard-view.ts:83src/ui/dashboard-view.ts:95src/ui/dashboard-view.ts:137src/ui/dashboard-view.ts:140src/ui/dashboard-view.ts:153src/ui/dashboard-view.ts:154src/ui/dashboard-view.ts:204src/ui/day-task-row.ts:3src/ui/pm-compass-view.ts:134src/ui/week-summary-view.ts:3src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:24src/ui/week-summary-view.ts:25src/ui/week-summary-view.ts:53
    Warning
    - [x] Unsafe member access on an error or any typed value@typescript-eslint/no-unsafe-member-accesssrc/model/day-markdown-file.ts:31src/model/day-markdown-file.ts:66src/model/day-markdown-file.ts:67src/model/day-markdown-file.ts:180src/model/day-task-actions.ts:93src/model/day-task-actions.ts:93src/model/day-task-actions.ts:93src/model/day-task-actions.ts:94src/model/day-task-actions.ts:97src/model/day-task-actions.ts:150src/model/day-task-actions.ts:159src/model/project-file.ts:55src/model/project-file.ts:56src/model/project-file.ts:56src/model/project-file.ts:57src/model/project-file.ts:57src/model/project-task-file.ts:141src/model/project-task-file.ts:141src/model/project-task-file.ts:143src/model/project-task-file.ts:143src/model/project-task-file.ts:145src/model/project-task-file.ts:145src/model/project-task-file.ts:147src/model/project-task-file.ts:169src/model/project-task-file.ts:170src/model/project-task-file.ts:171src/model/project-task-file.ts:171src/model/project-task-file.ts:172src/model/project-task-file.ts:173src/model/project-task-file.ts:173src/model/project-task-file.ts:174src/model/project-task-file.ts:174src/model/project-task-file.ts:175src/model/project-task-file.ts:175src/model/project-task-file.ts:176src/model/project-task-file.ts:177src/model/project-task-file.ts:177src/model/project-task-file.ts:197src/model/project-task-file.ts:197src/model/project-task-file.ts:198src/model/project-task-file.ts:208src/model/project-task-file.ts:208src/model/project-task-file.ts:209src/model/project-task-file.ts:234src/model/project-task-file.ts:234src/model/project-task-file.ts:235src/model/project-task-file.ts:253src/model/project-task-file.ts:253src/model/project-task-file.ts:254src/model/project-task-file.ts:290src/model/project-task-file.ts:290src/model/project-task-file.ts:291src/model/recurring-task-backfill.ts:26src/model/recurring-task-backfill.ts:41src/model/recurring-task-backfill.ts:48src/model/recurring-task-backfill.ts:59src/model/task-scoring.ts:9src/model/task-scoring.ts:10src/model/task-scoring.ts:11src/model/task-scoring.ts:22src/model/task-scoring.ts:23src/model/task-scoring.ts:24src/model/task-scoring.ts:67src/model/task-scoring.ts:72src/model/task-scoring.ts:79src/model/task-vocabulary.ts:67src/model/task-vocabulary.ts:67src/model/week-summary.ts:74src/model/week-summary.ts:75src/model/week-summary.ts:76src/model/week-summary.ts:79src/model/week-summary.ts:80src/ui/dashboard-view.ts:52src/ui/dashboard-view.ts:55src/ui/dashboard-view.ts:65src/ui/dashboard-view.ts:69src/ui/dashboard-view.ts:90src/ui/dashboard-view.ts:95src/ui/dashboard-view.ts:113src/ui/dashboard-view.ts:137src/ui/dashboard-view.ts:153src/ui/dashboard-view.ts:154src/ui/dashboard-view.ts:165src/ui/dashboard-view.ts:204src/ui/day-task-row.ts:306src/ui/pm-compass-view.ts:62src/ui/pm-compass-view.ts:62src/ui/pm-compass-view.ts:63src/ui/pm-compass-view.ts:134src/ui/pm-compass-view.ts:135src/ui/pm-compass-view.ts:136src/ui/task-graph-view.ts:508src/ui/task-graph-view.ts:509src/ui/task-graph-view.ts:510src/ui/task-graph-view.ts:695src/ui/task-graph-view.ts:695src/ui/task-graph-view.ts:738src/ui/task-graph-view.ts:881src/ui/task-graph-view.ts:907src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:24src/ui/week-summary-view.ts:25src/ui/week-summary-view.ts:39src/ui/week-summary-view.ts:39src/ui/week-summary-view.ts:54src/ui/week-summary-view.ts:54
    Warning
    - [x] Unsafe call of an error or any typed value@typescript-eslint/no-unsafe-callsrc/model/day-markdown-file.ts:65src/model/day-markdown-file.ts:66src/model/day-markdown-file.ts:67src/model/day-markdown-file.ts:180src/model/day-task-actions.ts:57src/model/day-task-actions.ts:93src/model/day-task-actions.ts:93src/model/day-task-actions.ts:93src/model/day-task-actions.ts:93src/model/day-task-actions.ts:94src/model/day-task-actions.ts:97src/model/day-task-actions.ts:150src/model/day-task-actions.ts:159src/model/day-task-actions.ts:159src/model/recurring-task-backfill.ts:26src/model/recurring-task-backfill.ts:26src/model/recurring-task-backfill.ts:41src/model/recurring-task-backfill.ts:41src/model/recurring-task-backfill.ts:48src/model/recurring-task-backfill.ts:59src/model/task-scoring.ts:9src/model/task-scoring.ts:9src/model/task-scoring.ts:10src/model/task-scoring.ts:10src/model/task-scoring.ts:11src/model/task-scoring.ts:22src/model/task-scoring.ts:22src/model/task-scoring.ts:23src/model/task-scoring.ts:23src/model/task-scoring.ts:24src/model/task-scoring.ts:67src/model/task-scoring.ts:67src/model/task-scoring.ts:72src/model/task-scoring.ts:72src/model/task-scoring.ts:79src/model/task-scoring.ts:79src/model/task-scoring.ts:79src/model/task-vocabulary.ts:67src/model/task-vocabulary.ts:67src/model/week-summary.ts:71src/model/week-summary.ts:74src/model/week-summary.ts:74src/model/week-summary.ts:75src/model/week-summary.ts:76src/model/week-summary.ts:79src/model/week-summary.ts:80src/ui/dashboard-view.ts:38src/ui/dashboard-view.ts:52src/ui/dashboard-view.ts:52src/ui/dashboard-view.ts:55src/ui/dashboard-view.ts:58src/ui/dashboard-view.ts:65src/ui/dashboard-view.ts:65src/ui/dashboard-view.ts:69src/ui/dashboard-view.ts:83src/ui/dashboard-view.ts:90src/ui/dashboard-view.ts:95src/ui/dashboard-view.ts:95src/ui/dashboard-view.ts:113src/ui/dashboard-view.ts:113src/ui/dashboard-view.ts:137src/ui/dashboard-view.ts:137src/ui/dashboard-view.ts:153src/ui/dashboard-view.ts:153src/ui/dashboard-view.ts:154src/ui/dashboard-view.ts:165src/ui/dashboard-view.ts:204src/ui/day-task-row.ts:300src/ui/day-task-row.ts:306src/ui/pm-compass-view.ts:135src/ui/pm-compass-view.ts:136src/ui/task-graph-view.ts:508src/ui/task-graph-view.ts:509src/ui/task-graph-view.ts:510src/ui/task-graph-view.ts:695src/ui/task-graph-view.ts:695src/ui/task-graph-view.ts:738src/ui/task-graph-view.ts:881src/ui/task-graph-view.ts:907src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:23src/ui/week-summary-view.ts:24src/ui/week-summary-view.ts:24src/ui/week-summary-view.ts:25src/ui/week-summary-view.ts:39src/ui/week-summary-view.ts:39src/ui/week-summary-view.ts:53src/ui/week-summary-view.ts:54src/ui/week-summary-view.ts:54
    Warning
    - [x] Returns unsafe values from typed code@typescript-eslint/no-unsafe-returnsrc/model/day-markdown-file.ts:67src/model/task-scoring.ts:80src/model/task-vocabulary.ts:67src/ui/week-summary-view.ts:54
    Warning
    - [x] Passes unsafe values into typed parameters@typescript-eslint/no-unsafe-argumentsrc/model/day-markdown-file.ts:209src/model/project-file.ts:58src/model/project-task-file.ts:150src/model/project-task-file.ts:178src/model/project-task-file.ts:199src/model/project-task-file.ts:210src/model/project-task-file.ts:236src/model/project-task-file.ts:255src/model/project-task-file.ts:292src/model/recurring-task-backfill.ts:59src/model/task-scoring.ts:25src/ui/dashboard-view.ts:113
    Warning
    - [x] Irregular whitespace not allowed.src/model/day-task.ts:44
    Warning
    - [x] Use 'FileManager.trashFile()' instead of 'Vault.delete()' to respect the user's file deletion preference.src/model/project-task-file.ts:225
    Warning
    - [x] Use 'activeDocument' instead of 'document' for popout window compatibility.src/ui/base-tab-view.ts:60src/ui/base-tab-view.ts:63src/ui/day-task-row.ts:274src/ui/day-task-row.ts:278src/ui/day-task-row.ts:280src/ui/icons.ts:22src/ui/pm-compass-view.ts:159src/ui/pm-compass-view.ts:164src/ui/progress-circle.ts:20src/ui/progress-circle.ts:26src/ui/progress-circle.ts:49src/ui/progress-circle.ts:61src/ui/task-creator.ts:118src/ui/task-creator.ts:122src/ui/task-creator.ts:124src/ui/task-creator.ts:147src/ui/task-graph-view.ts:97src/ui/task-graph-view.ts:353src/ui/task-graph-view.ts:434src/ui/task-graph-view.ts:436src/ui/task-graph-view.ts:443src/ui/task-graph-view.ts:456src/ui/task-graph-view.ts:475src/ui/task-graph-view.ts:476src/ui/task-graph-view.ts:477src/ui/task-graph-view.ts:485src/ui/task-graph-view.ts:487src/ui/task-graph-view.ts:488src/ui/task-graph-view.ts:1003src/ui/task-graph-view.ts:1023src/ui/task-graph-view.ts:1038src/ui/task-graph-view.ts:1061
    Warning
    - [x] Use 'window.setTimeout()' instead of 'setTimeout()' for popout window compatibility.src/ui/base-tab-view.ts:264src/ui/task-creator.ts:122src/ui/task-creator.ts:493src/ui/task-graph-view.ts:766src/ui/task-graph-view.ts:936
    Warning
    - [x] This assertion is unnecessary since it does not change the type of the expression.src/ui/progress-circle.ts:20src/ui/progress-circle.ts:26src/ui/progress-circle.ts:49src/ui/task-graph-view.ts:15src/ui/task-graph-view.ts:406src/ui/task-graph-view.ts:434src/ui/task-graph-view.ts:436src/ui/task-graph-view.ts:517src/ui/task-graph-view.ts:1003src/ui/task-graph-view.ts:1038
    Warning
    - [x] Promise returned in function argument where a void return was expected.src/ui/settings-tab.ts:330src/ui/task-creator.ts:378src/ui/task-creator.ts:643
    Warning
    - [x] Unnecessary escape character: \[.src/ui/task-creator.ts:462src/ui/task-creator.ts:471
    Recommendation
    - [x] display is deprecated. Since 1.13.0. Use {@link getSettingDefinitions} instead.src/ui/settings-tab.ts:37src/ui/settings-tab.ts:222src/ui/settings-tab.ts:261src/ui/settings-tab.ts:263src/ui/settings-tab.ts:266src/ui/settings-tab.ts:285src/ui/settings-tab.ts:294src/ui/settings-tab.ts:309src/ui/settings-tab.ts:322src/ui/settings-tab.ts:334src/ui/settings-tab.ts:347

CSS lint

    Warning
    - [x] Avoid !important — override styles by increasing selector specificity or using CSS variables instead.styles.css:150styles.css:151styles.css:152styles.css:215styles.css:216styles.css:217styles.css:476styles.css:477styles.css:478styles.css:492styles.css:493styles.css:494styles.css:507styles.css:508styles.css:567styles.css:573styles.css:1207styles.css:1208styles.css:1209

Dependencies

    Pass
    - [x] No vulnerable dependencies found.

Build verification

    Pass
    - [x] Build reproduced the release main.js byte-for-bytemain.jsThis confirms users are running exactly the code visible in the repository.
