# Project TODO List

- [ ] Implement unsubscribing from keyframe notifications 
- [ ] Types do not always match runtime data

        listWorkloadNamesForApplicationType() is typed as returning string[] on the backend/SDK side, but the frontend expects objects:

        {
        id: string;
        name: string;
        externalPackage: boolean;
        applicationType: string;
        }

        The runtime response likely is an object array, so the TypeScript types should be fixed.

- [ ] Implement Database lookup of username and password and return the json object that will be passed to Nest via api/ampp/session/bootstrap:
            curl -i -X POST http://localhost:3000/api/ampp/session/bootstrap \
            -H "Content-Type: application/json" \
            -d '{
                "platformUserId": "mock-user-123",
                "displayName": "Mock AMPP Operator",
                "sessionId": "mock-session-abc",
                "tenantId": "mock-tenant-main",
                "assignedWorkloads": [
                {
                    "id": "workload-001",
                    "name": "Main Program Output",
                    "applicationName": "AMPP Control"
                },
                {
                    "name": "Graphics Workload",
                    "applicationName": "AMPP Graphics"
                }
                ]
            }'