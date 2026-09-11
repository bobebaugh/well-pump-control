# Host-only exact dependency slice of tab5/pilot.py at 6d4b54cc9806e34b01343caf69f1df86e540d486.
# Generated from source AST dependencies; never imports or runs the hardware application.
import json as ujson

RULES_V3_SCHEMA_VERSION = 3

RULES_V3_PACKAGE_KIND = 'well-pump-event-runtime-v3'

RUNTIME_DIRECT_BINDINGS = {
    'shelly-gen1-em': {
        'emeter/0.power': ('number', 'W', 'read'),
        'emeter/0.voltage': ('number', 'V', 'read'),
        'emeter/0.pf': ('number', None, 'read'),
        'emeter/0.total': ('number', 'Wh', 'read'),
        '$availability': ('boolean', None, 'read'),
    },
    'shelly-gen4-switch': {
        'SW(0)': ('boolean', None, 'read'),
        'RLY(0)': ('boolean', None, 'readWrite'),
        'UDF(IsLocked)': ('integer', 's', 'read'),
        '$availability': ('boolean', None, 'read'),
    },
    'tab5-runtime': {
        'values.adc_raw': ('integer', 'count', 'read'),
        'status.pressure_sensor_commissioned': ('boolean', None, 'read'),
        'status.adc_available': ('boolean', None, 'read'),
        'status.clock_synced': ('boolean', None, 'read'),
        'status.wifi_connected': ('boolean', None, 'read'),
        'status.cloud_available': ('boolean', None, 'read'),
        'values.battery_percent': ('number', '%', 'read'),
        'status.buffer_used_pct': ('number', '%', 'read'),
        'status.records_lost': ('integer', 'count', 'read'),
    },
}

def _v3_closed(value, required, allowed=None):
    if not isinstance(value, dict):
        return False
    keys = set(value.keys())
    allowed = set(required if allowed is None else allowed)
    return set(required).issubset(keys) and keys.issubset(allowed)

def _v3_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return value == value and value - value == 0
    except Exception:
        return False

def _v3_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)

def _v3_name(value):
    if not isinstance(value, str) or len(value) < 2 or len(value) > 64:
        return False
    if not (('A' <= value[0] <= 'Z') or ('a' <= value[0] <= 'z')):
        return False
    return all(('A' <= char <= 'Z') or ('a' <= char <= 'z') or
               ('0' <= char <= '9') or char == '_' for char in value[1:])

def _v3_id(value):
    if not isinstance(value, str) or len(value) < 2 or len(value) > 64:
        return False
    return all(('A' <= char <= 'Z') or ('a' <= char <= 'z') or
               ('0' <= char <= '9') or char in '_-' for char in value)

def _v3_logging(value):
    if not isinstance(value, dict):
        return False
    if value.get('mode') == 'delta':
        return (_v3_closed(value, ('mode', 'threshold')) and
                _v3_number(value.get('threshold')) and value['threshold'] > 0)
    return (_v3_closed(value, ('mode',)) and
            value.get('mode') in ('none', 'change', 'always'))

def _v3_typed_value(value, field_type, enum_values=None):
    if field_type == 'number':
        return _v3_number(value)
    if field_type == 'integer':
        return _v3_integer(value)
    if field_type == 'boolean':
        return isinstance(value, bool)
    if field_type == 'enum':
        return isinstance(value, str) and isinstance(enum_values, list) and value in enum_values
    if field_type == 'signal':
        return value is None
    return False

def _v3_enum_values(value):
    return (isinstance(value, list) and 2 <= len(value) <= 32 and
            all(isinstance(item, str) and item for item in value) and
            len(set(value)) == len(value))

def _v3_field(value):
    required = ('systemName', 'type', 'unit', 'logging', 'object', 'access')
    if not _v3_closed(value, required, required + ('enumValues', 'write')):
        return None
    field_type = value.get('type')
    if (not _v3_name(value.get('systemName')) or field_type not in
            ('number', 'integer', 'boolean', 'enum', 'signal') or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging')) or
            not isinstance(value.get('object'), str) or not value['object'] or
            len(value['object']) > 128 or value.get('access') not in ('read', 'readWrite')):
        return None
    enums = value.get('enumValues')
    if field_type == 'enum':
        if not _v3_enum_values(enums):
            return None
    elif enums is not None:
        return None
    write = value.get('write')
    if value['access'] == 'readWrite':
        if (not _v3_closed(write, ('method', 'parameters', 'normalValue')) or
                not isinstance(write.get('method'), str) or not write['method'] or
                not _v3_closed(write.get('parameters'), ('id', 'valueParameter')) or
                not _v3_integer(write['parameters'].get('id')) or
                not 0 <= write['parameters']['id'] <= 255 or
                not _v3_name(write['parameters'].get('valueParameter')) or
                not _v3_typed_value(write.get('normalValue'), field_type, enums)):
            return None
    elif write is not None:
        return None
    return {'type': field_type, 'enumValues': enums, 'assignmentTarget': value['access'] == 'readWrite'}

def _v3_output(value):
    required = ('systemName', 'type', 'unit', 'logging')
    if not _v3_closed(value, required, required + ('enumValues',)):
        return None
    field_type = value.get('type')
    enums = value.get('enumValues')
    if (not _v3_name(value.get('systemName')) or
            field_type not in ('number', 'integer', 'boolean', 'enum', 'signal') or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging'))):
        return None
    if field_type == 'enum':
        if not _v3_enum_values(enums):
            return None
    elif enums is not None:
        return None
    return {'type': field_type, 'enumValues': enums, 'assignmentTarget': False}

def _v3_system_field(value):
    common = ('id', 'systemName', 'label', 'source', 'runtimeRole', 'type', 'unit', 'logging')
    if not _v3_closed(value, common, common + ('enumValues', 'initialValue',
                                                'assignmentTarget', 'occurrenceKey')):
        return None
    if (not _v3_id(value.get('id')) or not _v3_name(value.get('systemName')) or
            not isinstance(value.get('label'), str) or not value['label'] or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging'))):
        return None
    role = value.get('runtimeRole')
    if role == 'operatingMode':
        exact = common + ('enumValues', 'initialValue', 'assignmentTarget')
        if (not _v3_closed(value, exact) or value.get('source') != 'session' or
                value.get('type') != 'enum' or value.get('enumValues') != ['Normal', 'Monitor'] or
                value.get('initialValue') != 'Normal' or value.get('assignmentTarget') is not True):
            return None
    elif role == 'working':
        exact = common + ('initialValue', 'assignmentTarget')
        if value.get('type') == 'enum':
            exact += ('enumValues',)
        if (not _v3_closed(value, exact) or value.get('source') != 'session' or
                value.get('type') not in ('number', 'integer', 'boolean', 'enum') or
                not isinstance(value.get('assignmentTarget'), bool) or
                not _v3_typed_value(value.get('initialValue'), value.get('type'),
                                    value.get('enumValues'))):
            return None
        if value.get('type') == 'enum' and not _v3_enum_values(value.get('enumValues')):
            return None
    elif role == 'occurrence':
        exact = common + ('occurrenceKey',)
        if (not _v3_closed(value, exact) or value.get('source') not in
                ('manualOccurrence', 'internalOccurrence') or value.get('type') != 'signal' or
                not _v3_name(value.get('occurrenceKey'))):
            return None
    else:
        return None
    return {'type': value['type'], 'enumValues': value.get('enumValues'),
            'assignmentTarget': value.get('assignmentTarget') is True,
            'role': role, 'source': value['source']}

def _v3_clause(value, fields):
    if not _v3_closed(value, ('field', 'operator', 'value')):
        return False
    field = fields.get(value.get('field'))
    operator = value.get('operator')
    if field is None or operator not in ('lt', 'lte', 'gt', 'gte', 'eq', 'neq',
                                         'between', 'outside', 'changes',
                                         'changes_from', 'changes_to', 'occurs'):
        return False
    field_type = field['type']
    compared = value.get('value')
    if operator in ('lt', 'lte', 'gt', 'gte'):
        return field_type in ('number', 'integer') and _v3_number(compared)
    if operator in ('between', 'outside'):
        return (field_type in ('number', 'integer') and isinstance(compared, list) and
                len(compared) == 2 and all(_v3_number(item) for item in compared))
    if operator == 'occurs':
        return field_type == 'signal' and compared is None
    return _v3_typed_value(compared, field_type, field.get('enumValues'))

def _v3_condition(value, fields, qualified):
    required = ('mode', 'clauses') + (('observationCount', 'minimumSeconds') if qualified else ())
    if not _v3_closed(value, required):
        return False
    clauses = value.get('clauses')
    if (value.get('mode') not in ('all', 'any') or not isinstance(clauses, list) or
            not 1 <= len(clauses) <= 16 or not all(_v3_clause(item, fields) for item in clauses)):
        return False
    if qualified:
        return (_v3_integer(value.get('observationCount')) and
                1 <= value['observationCount'] <= 86400 and _v3_number(value.get('minimumSeconds')) and
                0 <= value['minimumSeconds'] <= 86400)
    return True

def _v3_phase(value, fields, event_class, close_phase):
    if not _v3_closed(value, ('assignments', 'guardedGroups')):
        return False
    assignments = value.get('assignments')
    groups = value.get('guardedGroups')
    if (not isinstance(assignments, list) or len(assignments) > 32 or
            not isinstance(groups, list) or len(groups) > 16):
        return False
    all_assignments = list(assignments)
    for group in groups:
        if (not _v3_closed(group, ('guard', 'assignments')) or
                not _v3_condition(group.get('guard'), fields, False) or
                not isinstance(group.get('assignments'), list) or
                not 1 <= len(group['assignments']) <= 32):
            return False
        all_assignments.extend(group['assignments'])
    for assignment in all_assignments:
        if not _v3_closed(assignment, ('target', 'value', 'ownership')):
            return False
        target = fields.get(assignment.get('target'))
        if (target is None or target.get('assignmentTarget') is not True or
                assignment.get('ownership') not in ('transition', 'whileOpen') or
                not _v3_typed_value(assignment.get('value'), target['type'],
                                    target.get('enumValues'))):
            return False
        if close_phase and assignment['ownership'] != 'transition':
            return False
        if target.get('role') == 'operatingMode':
            if (event_class != 'monitor' or assignment['value'] != 'Monitor' or
                    assignment['ownership'] != 'whileOpen'):
                return False
        elif event_class == 'monitor':
            return False
    return True

def _v3_dependencies_acyclic(dependencies):
    """Check declared calculated-name references without evaluating anything."""
    visiting = set()
    completed = set()

    def visit(name):
        if name in completed:
            return True
        if name in visiting:
            return False
        visiting.add(name)
        for dependency in dependencies.get(name, ()):
            if not visit(dependency):
                return False
        visiting.remove(name)
        completed.add(name)
        return True

    return all(visit(name) for name in dependencies)

def _rules_v3_package_valid(package):
    root = ('schemaVersion', 'kind', 'releaseId', 'packageVersion', 'adoption',
            'lifecycle', 'devices', 'calculations', 'systemFields', 'events')
    if not _v3_closed(package, root):
        return False
    if (package.get('schemaVersion') != RULES_V3_SCHEMA_VERSION or
            package.get('kind') != RULES_V3_PACKAGE_KIND or
            not _v3_integer(package.get('packageVersion')) or package['packageVersion'] < 1 or
            not isinstance(package.get('releaseId'), str) or
            package['releaseId'] != '{}-event-v3-v{}'.format(
                package['releaseId'][:14], package['packageVersion']) or
            not package['releaseId'][:14].isdigit()):
        return False
    if (not _v3_closed(package.get('adoption'), ('runtimeSchemaVersion', 'legacyPackagePolicy')) or
            package['adoption'].get('runtimeSchemaVersion') != 3 or
            package['adoption'].get('legacyPackagePolicy') != 'reject'):
        return False
    lifecycle = package.get('lifecycle')
    if (not _v3_closed(lifecycle, ('qualification', 'ownership', 'monitor')) or
            lifecycle.get('ownership') != 'event_instance_set' or
            not _v3_closed(lifecycle.get('qualification'),
                           ('observationCount', 'minimumSeconds', 'countAndTimeBothRequired',
                            'missingEvidence')) or
            lifecycle['qualification'] != {'observationCount': 'consecutive',
                                           'minimumSeconds': 'continuous',
                                           'countAndTimeBothRequired': True,
                                           'missingEvidence': 'freezes_qualification'} or
            not _v3_closed(lifecycle.get('monitor'), ('resource',)) or
            lifecycle['monitor'].get('resource') != 'declared_operating_mode'):
        return False
    devices = package.get('devices')
    if not isinstance(devices, list) or not 1 <= len(devices) <= 16:
        return False
    fields = {}
    ids = set()
    for device in devices:
        if (not _v3_closed(device, ('id', 'driver', 'address', 'enabled', 'fields')) or
                not _v3_id(device.get('id')) or device['id'] in ids or
                not isinstance(device.get('driver'), str) or not device['driver'] or
                not isinstance(device.get('address'), str) or not device['address'] or
                not isinstance(device.get('enabled'), bool) or
                not isinstance(device.get('fields'), list) or not 1 <= len(device['fields']) <= 32):
            return False
        ids.add(device['id'])
        for field in device['fields']:
            checked = _v3_field(field)
            if checked is None or field['systemName'] in fields:
                return False
            fields[field['systemName']] = checked
    system_fields = package.get('systemFields')
    if not isinstance(system_fields, list) or not 1 <= len(system_fields) <= 32:
        return False
    for field in system_fields:
        checked = _v3_system_field(field)
        if checked is None or field['systemName'] in fields:
            return False
        fields[field['systemName']] = checked
    if not any(item.get('role') == 'operatingMode' for item in fields.values()):
        return False
    calculations = package.get('calculations')
    if not isinstance(calculations, list) or len(calculations) > 64:
        return False
    calculation_ids = set()
    calculated_output_owner = {}
    for item in calculations:
        if not isinstance(item, dict) or not _v3_id(item.get('id')) or item['id'] in calculation_ids:
            return False
        calculation_ids.add(item['id'])
        outputs = ([item.get('output')] if item.get('kind') == 'expression'
                   else item.get('outputs'))
        if not isinstance(outputs, list):
            outputs = [outputs]
        for output in outputs:
            checked = _v3_output(output)
            if checked is None or output['systemName'] in fields:
                return False
            fields[output['systemName']] = checked
            calculated_output_owner[output['systemName']] = item['id']
    dependencies = {item['id']: set() for item in calculations}
    for item in calculations:
        if item.get('kind') == 'expression':
            if (not _v3_closed(item, ('id', 'kind', 'expression', 'program', 'output')) or
                    not isinstance(item.get('expression'), str) or len(item['expression']) > 512 or
                    not isinstance(item.get('program'), list) or not item['program'] or len(item['program']) > 128):
                return False
            for token in item['program']:
                if (not isinstance(token, list) or len(token) != 2 or token[0] not in
                        ('number', 'field', 'operator') or
                        (token[0] == 'number' and not _v3_number(token[1])) or
                        (token[0] == 'field' and token[1] not in fields) or
                        (token[0] == 'operator' and token[1] not in ('+', '-', '*', '/'))):
                    return False
                if token[0] == 'field' and token[1] in calculated_output_owner:
                    dependencies[item['id']].add(calculated_output_owner[token[1]])
        elif item.get('kind') == 'function':
            required = ('id', 'kind', 'functionId', 'inputs', 'parameters', 'outputs')
            if (not _v3_closed(item, required) or item.get('functionId') != 'boyle_tank' or
                    not _v3_closed(item.get('inputs'), ('pressure',)) or
                    item['inputs'].get('pressure') not in fields or
                    not _v3_closed(item.get('parameters'),
                                   ('effectiveTankGallons', 'prechargeGaugePsi',
                                    'atmosphericPressurePsi', 'regressionWindowSeconds',
                                    'minimumSamples')) or
                    not all(_v3_number(value) for value in item['parameters'].values()) or
                    not isinstance(item.get('outputs'), list) or len(item['outputs']) != 5):
                return False
            input_name = item['inputs']['pressure']
            if input_name in calculated_output_owner:
                dependencies[item['id']].add(calculated_output_owner[input_name])
        else:
            return False
    if not _v3_dependencies_acyclic(dependencies):
        return False
    events = package.get('events')
    if not isinstance(events, list) or len(events) > 64:
        return False
    event_ids = set()
    event_names = set()
    for event in events:
        required = ('id', 'systemName', 'displayName', 'severity', 'enabled', 'eventClass',
                    'opening', 'closing', 'onOpen', 'onClose', 'summary')
        if (not _v3_closed(event, required) or not _v3_id(event.get('id')) or
                event['id'] in event_ids or not _v3_name(event.get('systemName')) or
                event['systemName'] in event_names or not isinstance(event.get('displayName'), str) or
                not 1 <= len(event['displayName']) <= 160 or event.get('severity') not in
                ('Info', 'Yellow', 'Red') or not isinstance(event.get('enabled'), bool) or
                event.get('eventClass') not in ('transient', 'latched', 'monitor') or
                not _v3_closed(event.get('opening'), ('trigger',))):
            return False
        event_ids.add(event['id'])
        event_names.add(event['systemName'])
        trigger = event['opening'].get('trigger')
        if not isinstance(trigger, dict) or trigger.get('type') not in ('condition', 'manual', 'internal'):
            return False
        if trigger['type'] == 'condition':
            if not _v3_closed(trigger, ('type', 'condition')) or not _v3_condition(trigger.get('condition'), fields, True):
                return False
        else:
            if (not _v3_closed(trigger, ('type', 'occurrenceField', 'qualification')) or
                    fields.get(trigger.get('occurrenceField'), {}).get('role') != 'occurrence' or
                    fields[trigger['occurrenceField']].get('source') !=
                    ('manualOccurrence' if trigger['type'] == 'manual' else 'internalOccurrence') or
                    not _v3_closed(trigger.get('qualification'), ('observationCount', 'minimumSeconds')) or
                    not _v3_integer(trigger['qualification'].get('observationCount')) or
                    not 1 <= trigger['qualification']['observationCount'] <= 86400 or
                    not _v3_number(trigger['qualification'].get('minimumSeconds')) or
                    not 0 <= trigger['qualification']['minimumSeconds'] <= 86400):
                return False
        closing = event.get('closing')
        if not isinstance(closing, dict) or closing.get('policy') not in ('condition', 'clearEvents', 'immediate'):
            return False
        if closing['policy'] == 'condition':
            if not _v3_closed(closing, ('policy', 'condition')) or not _v3_condition(closing.get('condition'), fields, True):
                return False
        elif not _v3_closed(closing, ('policy',)):
            return False
        if ((event['eventClass'] == 'latched' and closing['policy'] != 'clearEvents') or
                (event['eventClass'] == 'transient' and closing['policy'] not in ('condition', 'immediate')) or
                (event['eventClass'] == 'monitor' and closing['policy'] not in ('condition', 'clearEvents')) or
                not _v3_phase(event.get('onOpen'), fields, event['eventClass'], False) or
                not _v3_phase(event.get('onClose'), fields, event['eventClass'], True)):
            return False
        summary = event.get('summary')
        if not _v3_closed(summary, ('durationOutput', 'aggregates')) or not isinstance(summary.get('aggregates'), list) or len(summary['aggregates']) > 32:
            return False
        if summary['durationOutput'] is not None and _v3_output(summary['durationOutput']) is None:
            return False
        for aggregate in summary['aggregates']:
            if (not _v3_closed(aggregate, ('source', 'operation', 'scale', 'output')) or
                    aggregate.get('source') not in fields or aggregate.get('operation') not in
                    ('start', 'end', 'delta', 'average', 'minimum', 'maximum') or
                    not _v3_number(aggregate.get('scale')) or _v3_output(aggregate.get('output')) is None):
                return False
    return True

def _rules_v3_runtime_supported(package):
    """Reject schema-valid declarations that this device application cannot execute."""
    for device in package.get('devices', []):
        bindings = RUNTIME_DIRECT_BINDINGS.get(device.get('driver'))
        if not isinstance(bindings, dict):
            return False
        for field in device.get('fields', []):
            binding = bindings.get(field.get('object'))
            if binding != (field.get('type'), field.get('unit'), field.get('access')):
                return False
            if field.get('access') == 'readWrite':
                write = field.get('write')
                if (device.get('driver') != 'shelly-gen4-switch' or
                        not isinstance(write, dict) or write.get('method') != 'Switch.Set' or
                        write.get('parameters') != {'id': 0, 'valueParameter': 'on'} or
                        write.get('normalValue') is not True):
                    return False
    for calculation in package.get('calculations', []):
        if calculation.get('kind') == 'expression':
            if calculation.get('output', {}).get('type') != 'number':
                return False
        elif calculation.get('kind') == 'function':
            parameters = calculation.get('parameters', {})
            outputs = calculation.get('outputs', [])
            if (calculation.get('functionId') != 'boyle_tank' or
                    len(outputs) != 5 or
                    [item.get('type') for item in outputs] !=
                    ['number', 'number', 'number', 'number', 'enum'] or
                    not _v3_number(parameters.get('effectiveTankGallons')) or
                    parameters['effectiveTankGallons'] <= 0 or
                    not _v3_number(parameters.get('atmosphericPressurePsi')) or
                    parameters['atmosphericPressurePsi'] <= 0 or
                    not _v3_number(parameters.get('prechargeGaugePsi')) or
                    not _v3_number(parameters.get('regressionWindowSeconds')) or
                    parameters['regressionWindowSeconds'] <= 0 or
                    not _v3_integer(parameters.get('minimumSamples')) or
                    parameters['minimumSamples'] < 2):
                return False
            required_quality = {
                'VALID', 'INSUFFICIENT_HISTORY', 'PRESSURE_INVALID',
                'SAMPLE_GAP', 'TREND_UNRESOLVED', 'TANK_MODEL_INVALID'}
            if set(outputs[4].get('enumValues') or ()) != required_quality:
                return False
        else:
            return False
    for event in package.get('events', []):
        summary = event.get('summary', {})
        if summary.get('durationOutput') is not None or summary.get('aggregates'):
            return False
    return True

def resolve_rules_v3_package(package):
    """Resolve one validated V3 package for the pure kernel; perform no I/O."""
    if isinstance(package, str):
        try:
            package = ujson.loads(package)
        except Exception:
            return None
    if not _rules_v3_package_valid(package) or not _rules_v3_runtime_supported(package):
        return None
    devices = {}
    writable = {}
    field_types = {}
    for device in package['devices']:
        resolved_fields = []
        for field in device['fields']:
            resolved_field = {
                'object': field['object'], 'systemName': field['systemName'],
                'type': field['type'], 'enumValues': field.get('enumValues'),
            }
            resolved_fields.append(resolved_field)
            field_types[field['systemName']] = {
                'type': field['type'], 'enumValues': field.get('enumValues')}
            if field.get('access') == 'readWrite':
                writable[field['systemName']] = {
                    'type': field['type'], 'enumValues': field.get('enumValues'),
                    'normalValue': field['write']['normalValue'],
                    'method': field['write'].get('method'),
                    'parameters': field['write'].get('parameters') or {},
                    'deviceId': device['id'], 'object': field['object'],
                }
        devices[device['id']] = {
            'enabled': device['enabled'], 'fields': resolved_fields,
            'driver': device['driver']}
    initial_fields = {}
    operating_mode_target = None
    for field in package['systemFields']:
        field_types[field['systemName']] = {
            'type': field['type'], 'enumValues': field.get('enumValues')}
        if 'initialValue' in field:
            initial_fields[field['systemName']] = field['initialValue']
        if field.get('assignmentTarget') is True:
            writable[field['systemName']] = {
                'type': field['type'], 'enumValues': field.get('enumValues'),
                'normalValue': field.get('initialValue'),
            }
        if field.get('runtimeRole') == 'operatingMode':
            operating_mode_target = field['systemName']
    pump_target = 'PumpEnable' if 'PumpEnable' in writable else None
    lock_field = 'IsLocked' if 'IsLocked' in field_types else None
    tab5_objects = {}
    for device in package['devices']:
        if device.get('driver') == 'tab5-runtime':
            tab5_objects.update({field['object']: field['systemName']
                                 for field in device['fields']})
    adc_field = tab5_objects.get('values.adc_raw')
    pressure_guards = [
        tab5_objects.get('status.pressure_sensor_commissioned'),
        tab5_objects.get('status.adc_available'),
    ]
    available = set(field['systemName'] for device in package['devices']
                    for field in device['fields'])
    available.update(field['systemName'] for field in package['systemFields'])
    remaining = list(package['calculations'])
    calculation_plan = []
    while remaining:
        progressed = False
        for calculation in list(remaining):
            dependencies = ([token[1] for token in calculation.get('program', [])
                             if token[0] == 'field']
                            if calculation['kind'] == 'expression' else
                            [calculation['inputs']['pressure']])
            if all(name in available for name in dependencies):
                resolved_calculation = dict(calculation)
                if calculation['kind'] == 'expression' and adc_field in dependencies:
                    if adc_field is None or any(name is None for name in pressure_guards):
                        return None
                    resolved_calculation['_requiredTrueFields'] = list(pressure_guards)
                calculation_plan.append(resolved_calculation)
                outputs = ([calculation['output']] if calculation['kind'] == 'expression'
                           else calculation['outputs'])
                available.update(output['systemName'] for output in outputs)
                remaining.remove(calculation)
                progressed = True
        if not progressed:
            return None
    return {
        'releaseId': package['releaseId'],
        'packageVersion': package['packageVersion'],
        'events': list(package['events']),
        'devices': devices,
        'fieldTypes': field_types,
        'initialFields': initial_fields,
        'writableTargets': writable,
        'operatingModeTarget': operating_mode_target,
        'pumpTarget': pump_target,
        'lockField': lock_field,
        'calculations': calculation_plan,
    }

if __name__ == "__main__":
    import sys
    print(ujson.dumps([resolve_rules_v3_package(p) is not None for p in ujson.load(sys.stdin)]))
